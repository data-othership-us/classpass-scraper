/**
 * ClassPass – scrape report pages with saved cookies, download PDFs, extract data.
 * Returns revenue data in memory. Use with monthly-job or backfill for BigQuery upload.
 *
 * Usage: npm run reports | npm run reports:headed
 */
import puppeteer from "puppeteer";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve, join, basename } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { extractFromPdf, parseReportText } from "./extract-pdf.js";
import { uploadToBigQuery } from "./upload-to-bigquery.js";
import { COOKIES_FILE, DOWNLOADS_DIR, LOGIN_URL, getStudios } from "./lib/config.js";
import { getLaunchOptions, USER_AGENT } from "./lib/browser.js";
import { tryDownloadPdfForStudio } from "./lib/pdf-download.js";

const REPORT_YEAR = process.env.REPORT_YEAR || "2026";
const REPORT_MONTH = process.env.REPORT_MONTH || "01";
const STUDIOS = getStudios(REPORT_YEAR, REPORT_MONTH);
const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";

/** Run scrape for current REPORT_YEAR/REPORT_MONTH. Returns revenueData (no file written). */
export async function runReports() {
  if (!existsSync(COOKIES_FILE)) {
    console.error("No cookies file. Run: npm run get-cookies:headed");
    process.exit(1);
  }

  const cookies = JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
  if (!Array.isArray(cookies) || cookies.length === 0) {
    console.error("cookies.json is empty.");
    process.exit(1);
  }

  const browser = await puppeteer.launch(getLaunchOptions(HEADED));
  const page = await browser.newPage();

  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS_DIR });
  await page.setUserAgent(USER_AGENT);

  const reportYearMonth = `${REPORT_YEAR}-${REPORT_MONTH}`;
  const revenueData = {
    reportPeriod: reportYearMonth,
    scrapedAt: new Date().toISOString(),
    studios: [],
    extracted: [],
  };
  const existingFiles = new Set(existsSync(DOWNLOADS_DIR) ? readdirSync(DOWNLOADS_DIR) : []);

  try {
    console.log("Going to /login to set domain...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.setCookie(...cookies);
    console.log("Cookies set.\n");

    console.log("Step 1: Scrape report pages and download PDFs");
    console.log("----------------------------------------------");
    for (const studio of STUDIOS) {
      console.log(`${studio.name}: ${studio.url}`);
      const { pdfPath, sessionExpired, loadFailed } = await tryDownloadPdfForStudio(
        page,
        studio,
        REPORT_YEAR,
        REPORT_MONTH,
        cookies,
        existingFiles,
        DOWNLOADS_DIR
      );

      if (sessionExpired) {
        console.log("  → Redirected to login (cookies expired).");
        revenueData.studios.push({ name: studio.name, url: studio.url, error: "Session expired", pdfDownloaded: false });
        break;
      }
      if (loadFailed) {
        console.log("  → Failed to load");
        revenueData.studios.push({ name: studio.name, url: studio.url, error: "Failed to load page", pdfDownloaded: false });
        continue;
      }

      const pageText = await page.evaluate(() => document.body?.innerText || "");
      const parsed = parseReportText(pageText);
      revenueData.extracted.push({
        studio: studio.name,
        source: "page",
        earnings: parsed.earnings,
        currency: parsed.currency,
        reservations: parsed.reservations,
        utilization: parsed.utilization,
        period: parsed.period,
        studioName: parsed.studioName,
      });
      if (parsed.earnings || parsed.reservations != null || parsed.utilization) {
        console.log("  → Extracted from page:", parsed.earnings || "-", parsed.reservations ?? "-", parsed.utilization ?? "-");
      } else if (pageText.length > 0 && process.env.PAGE_SNIPPET === "1") {
        const snippetPath = join(DOWNLOADS_DIR, `${studio.name}-page-snippet.txt`);
        writeFileSync(snippetPath, pageText.slice(0, 8000), "utf8");
        console.log("  → Wrote", snippetPath);
      }

      if (pdfPath) {
        console.log("  → Saved", basename(pdfPath));
      } else {
        console.log("  → No PDF downloaded");
      }

      revenueData.studios.push({
        name: studio.name,
        url: studio.url,
        pdfDownloaded: !!pdfPath,
        pdfPath: pdfPath || undefined,
      });

      if (pdfPath) {
        try {
          const data = await extractFromPdf(pdfPath);
          revenueData.extracted.push({
            file: basename(pdfPath),
            studio: studio.name,
            source: "pdf",
            earnings: data.earnings,
            currency: data.currency,
            reservations: data.reservations,
            utilization: data.utilization,
            period: data.period,
          });
          console.log("  → Extracted from PDF, location from URL:", studio.name);
        } catch (err) {
          revenueData.extracted.push({ file: basename(pdfPath), studio: studio.name, source: "pdf", error: err.message });
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    const expectedPdfs = new Set(STUDIOS.map((s) => `${s.name}-${REPORT_YEAR}-${REPORT_MONTH}.pdf`));
    const allPdfs = existsSync(DOWNLOADS_DIR) ? readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".pdf")) : [];
    for (const file of allPdfs) {
      if (!expectedPdfs.has(file)) {
        try {
          unlinkSync(join(DOWNLOADS_DIR, file));
          console.log("  Removed extra PDF:", file);
        } catch (_) {}
      }
    }

    console.log("\nStep 2: Extract from PDFs not yet processed (e.g. extra files in reports-pdf/)");
    console.log("------------------------------------------------------------------------------");
    const pdfFiles = existsSync(DOWNLOADS_DIR) ? readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".pdf")) : [];
    const extractedFiles = new Set(revenueData.extracted.filter((e) => e.file).map((e) => e.file));
    for (const file of pdfFiles) {
      if (extractedFiles.has(file)) {
        console.log("  Skipped (already extracted from URL):", file);
        continue;
      }
      const fullPath = join(DOWNLOADS_DIR, file);
      const studioFromFile = file.replace(/-\d{4}-\d{2}\.pdf$/i, "").replace(/-/g, " ");
      console.log("  PDF → location from filename:", file, "→ studio:", JSON.stringify(studioFromFile));
      try {
        const data = await extractFromPdf(fullPath);
        revenueData.extracted.push({
          file,
          studio: studioFromFile,
          source: "pdf",
          earnings: data.earnings,
          currency: data.currency,
          reservations: data.reservations,
          utilization: data.utilization,
          period: data.period,
        });
      } catch (err) {
        revenueData.extracted.push({ file, studio: studioFromFile, source: "pdf", error: err.message });
      }
    }
    if (pdfFiles.length === 0) {
      console.log("(No PDFs in reports-pdf/ – data above is from page only)");
    }

    console.log("\n--- Extracted data ---");
    console.log(JSON.stringify(revenueData, null, 2));
    console.log("PDFs in:", DOWNLOADS_DIR);
    return revenueData;
  } finally {
    await browser.close();
  }
}

async function main() {
  const revenueData = await runReports();
  if (process.env.GOOGLE_CLOUD_PROJECT && process.env.BIGQUERY_DATASET && process.env.BIGQUERY_TABLE) {
    try {
      const inserted = await uploadToBigQuery(revenueData);
      console.log("BigQuery: inserted", inserted, "row(s).");
    } catch (err) {
      console.error("BigQuery upload failed:", err.message);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
