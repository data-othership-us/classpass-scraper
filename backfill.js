/**
 * Backfill BigQuery with historical data from August 2022 to the current month.
 * Not all studios have data every month (some opened later); failed/skipped studios are skipped.
 *
 * Usage: npm run backfill | npm run backfill:headed
 * Requires: cookies.json. Optional: BigQuery env for upload.
 */
import puppeteer from "puppeteer";
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import "dotenv/config";
import { extractFromPdf } from "./extract-pdf.js";
import { uploadToBigQuery } from "./upload-to-bigquery.js";
import {  COOKIES_FILE,
  DOWNLOADS_DIR,
  LOGIN_URL,
  getStudios,
  getMonthsToBackfill,
  STUDIO_IDS,
} from "./lib/config.js";
import { getLaunchOptions, USER_AGENT } from "./lib/browser.js";
import { tryDownloadPdfForStudio } from "./lib/pdf-download.js";

const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";
const BACKFILL_START = process.env.BACKFILL_START || "2022-08";

async function main() {
  if (!existsSync(COOKIES_FILE)) {
    console.error("No cookies.json. Run: npm run get-cookies:headed");
    process.exit(1);
  }

  const cookies = JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
  if (!Array.isArray(cookies) || cookies.length === 0) {
    console.error("cookies.json is empty.");
    process.exit(1);
  }

  const months = getMonthsToBackfill(BACKFILL_START);
  console.log("Backfilling", months.length, "months from", BACKFILL_START, "to current.\n");

  const browser = await puppeteer.launch(getLaunchOptions(HEADED));
  const page = await browser.newPage();

  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS_DIR });
  await page.setUserAgent(USER_AGENT);

  const allExtracted = [];
  let sessionExpired = false;

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.setCookie(...cookies);
    console.log("Cookies set.\n");

    for (const { year, month } of months) {
      const yyyy = String(year);
      const mm = String(month).padStart(2, "0");
      const reportPeriod = `${yyyy}-${mm}`;
      const studios = getStudios(year, month);

      console.log(`--- ${reportPeriod} ---`);
      const existingFiles = new Set(existsSync(DOWNLOADS_DIR) ? readdirSync(DOWNLOADS_DIR) : []);

      for (const studio of studios) {
        const { pdfPath, sessionExpired: expired } = await tryDownloadPdfForStudio(
          page,
          studio,
          year,
          month,
          cookies,
          existingFiles,
          DOWNLOADS_DIR
        );

        if (expired) {
          console.log("  Session expired (redirected to login). Stop backfill and run get-cookies:headed.");
          sessionExpired = true;
          break;
        }

        if (pdfPath) {
          try {
            const data = await extractFromPdf(pdfPath);
            allExtracted.push({
              reportPeriod,
              file: basename(pdfPath),
              studio: studio.name,
              source: "pdf",
              earnings: data.earnings,
              currency: data.currency,
              reservations: data.reservations,
              utilization: data.utilization,
              period: data.period,
            });
            console.log(`  ${studio.name}: extracted`);
          } catch (err) {
            console.log(`  ${studio.name}: extract failed`, err.message);
          }
        } else {
          console.log(`  ${studio.name}: no PDF`);
        }

        await new Promise((r) => setTimeout(r, 800));
      }

      if (sessionExpired) break;

      for (const s of STUDIO_IDS) {
        const f = `${s.name}-${yyyy}-${mm}.pdf`;
        try {
          unlinkSync(join(DOWNLOADS_DIR, f));
        } catch (_) {}
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    const revenueData = {
      reportPeriod: BACKFILL_START,
      scrapedAt: new Date().toISOString(),
      extracted: allExtracted,
    };

    console.log("\nScraped", allExtracted.length, "rows.");

    if (process.env.GOOGLE_CLOUD_PROJECT && process.env.BIGQUERY_DATASET && process.env.BIGQUERY_TABLE) {
      const inserted = await uploadToBigQuery(revenueData);
      console.log("BigQuery: inserted", inserted, "row(s).");
    } else {
      console.log("Set BigQuery env vars and run npm run bigquery:upload to push to BigQuery.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
