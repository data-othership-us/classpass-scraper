/**
 * Backfill BigQuery with historical data from August 2022 to the current month.
 * Not all studios have data every month (some opened later); failed/skipped studios are skipped.
 *
 * Usage: npm run backfill | npm run backfill:headed
 * Requires: cookies.json. Optional: BigQuery env for upload.
 */
import puppeteer from "puppeteer";
import { BigQuery } from "@google-cloud/bigquery";
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
  getLastCompletedMonth,
  STUDIO_IDS,
} from "./lib/config.js";
import { getLaunchOptions, USER_AGENT } from "./lib/browser.js";
import { tryDownloadPdfForStudio } from "./lib/pdf-download.js";

const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";
const BACKFILL_START = process.env.BACKFILL_START || "2022-08";
const BACKFILL_END = process.env.BACKFILL_END || "";
const BACKFILL_FROM = process.env.BACKFILL_FROM || "";
const BACKFILL_TO = process.env.BACKFILL_TO || "";
const LOGIN_SETTLE_MS = Number(process.env.LOGIN_SETTLE_MS || 8000);
const STUDIO_DELAY_MS = Number(process.env.STUDIO_DELAY_MS || 7000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 45000);
const NAVIGATION_MAX_ATTEMPTS = Number(process.env.NAVIGATION_MAX_ATTEMPTS || 2);
const NAVIGATION_RETRY_DELAY_MS = Number(process.env.NAVIGATION_RETRY_DELAY_MS || 7000);
const KEEP_PDFS = process.env.KEEP_PDFS !== "0" && process.env.KEEP_PDFS !== "false";
const STOP_ON_ZERO_EARNINGS = process.env.STOP_ON_ZERO_EARNINGS !== "0" && process.env.STOP_ON_ZERO_EARNINGS !== "false";
const TRUNCATE_FIRST = process.env.TRUNCATE_FIRST === "1" || process.env.TRUNCATE_FIRST === "true";

function isAtOrBeforeMonth(year, month, maxYear, maxMonth) {
  return year < maxYear || (year === maxYear && month <= maxMonth);
}

function parseEarningsValue(earningsStr) {
  if (typeof earningsStr !== "string") return null;
  const n = Number.parseFloat(earningsStr.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseYearMonth(ym) {
  const m = String(ym || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

async function truncateBigQueryTableIfConfigured() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const datasetId = process.env.BIGQUERY_DATASET;
  const tableId = process.env.BIGQUERY_TABLE;

  if (!projectId || !datasetId || !tableId) {
    return false;
  }

  if (!TRUNCATE_FIRST) {
    console.log("TRUNCATE_FIRST not set; appending into existing BigQuery table.\n");
    return true;
  }

  const bigquery = new BigQuery({ projectId });
  const query = `TRUNCATE TABLE \`${projectId}.${datasetId}.${tableId}\``;
  console.log(`Truncating BigQuery table: ${projectId}.${datasetId}.${tableId}`);
  await bigquery.query({ query, useLegacySql: false });
  console.log("BigQuery table truncated.\n");
  return true;
}

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

  const { year: lastCompletedYear, month: lastCompletedMonth } = getLastCompletedMonth();
  const defaultFrom = parseYearMonth(BACKFILL_START) || { year: 2022, month: 8 };
  const defaultTo = parseYearMonth(BACKFILL_END) || { year: lastCompletedYear, month: lastCompletedMonth };
  const requestedFrom = parseYearMonth(BACKFILL_FROM) || defaultFrom;
  const requestedTo = parseYearMonth(BACKFILL_TO) || defaultTo;

  const lowerBound = compareYearMonth(requestedFrom, requestedTo) <= 0 ? requestedFrom : requestedTo;
  const upperBound = compareYearMonth(requestedFrom, requestedTo) <= 0 ? requestedTo : requestedFrom;

  const months = getMonthsToBackfill(`${lowerBound.year}-${String(lowerBound.month).padStart(2, "0")}`)
    .filter(({ year, month }) =>
      isAtOrBeforeMonth(year, month, upperBound.year, upperBound.month)
    )
    .reverse();
  if (months.length === 0) {
    console.log("No months to backfill.");
    return;
  }
  const firstMonth = `${months[0].year}-${String(months[0].month).padStart(2, "0")}`;
  const lastMonth = `${months[months.length - 1].year}-${String(months[months.length - 1].month).padStart(2, "0")}`;
  console.log("Backfilling", months.length, "months from", firstMonth, "down to", lastMonth, "(latest completed first).\n");

  const hasBigQueryConfig = await truncateBigQueryTableIfConfigured();
  if (!hasBigQueryConfig) {
    console.log("BigQuery env not fully set; backfill will run without truncation/upload.");
  }

  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  let browser = null;
  let page = null;
  let browserSessionReady = false;

  const allExtracted = [];
  let sessionExpired = false;
  const inactiveStudios = new Set();

  async function ensureBrowserSession() {
    if (browserSessionReady && page) return;
    if (!browser) {
      browser = await puppeteer.launch(getLaunchOptions(HEADED));
      page = await browser.newPage();
      const client = await page.createCDPSession();
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS_DIR });
      await page.setUserAgent(USER_AGENT);
    }
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.setCookie(...cookies);
    console.log("Cookies set.\n");
    if (LOGIN_SETTLE_MS > 0) {
      await new Promise((r) => setTimeout(r, LOGIN_SETTLE_MS));
    }
    browserSessionReady = true;
  }

  try {
    for (const { year, month } of months) {
      const yyyy = String(year);
      const mm = String(month).padStart(2, "0");
      const reportPeriod = `${yyyy}-${mm}`;
      const studios = getStudios(year, month).filter((s) => !inactiveStudios.has(s.name));

      console.log(`--- ${reportPeriod} ---`);
      if (studios.length === 0) {
        console.log("  All locations reached 0 earnings in newer months. Skipping remaining months.");
        break;
      }
      const existingFiles = new Set(existsSync(DOWNLOADS_DIR) ? readdirSync(DOWNLOADS_DIR) : []);

      for (const studio of studios) {
        const cachedPdf = join(DOWNLOADS_DIR, `${studio.name}-${yyyy}-${mm}.pdf`);
        let downloadResult;
        if (existsSync(cachedPdf)) {
          downloadResult = { pdfPath: cachedPdf, sessionExpired: false, loadFailed: false, loadError: null, fromCache: true };
        } else {
          await ensureBrowserSession();
          downloadResult = await tryDownloadPdfForStudio(
            page,
            studio,
            year,
            month,
            cookies,
            existingFiles,
            DOWNLOADS_DIR,
            {
              timeoutMs: NAVIGATION_TIMEOUT_MS,
              maxAttempts: NAVIGATION_MAX_ATTEMPTS,
              retryDelayMs: NAVIGATION_RETRY_DELAY_MS,
            }
          );
        }
        const { pdfPath, sessionExpired: expired, loadFailed, loadError, fromCache } = downloadResult;

        if (expired) {
          console.log("  Session expired (redirected to login). Stop backfill and run get-cookies:headed.");
          sessionExpired = true;
          break;
        }
        if (loadFailed) {
          console.log(`  ${studio.name}: load failed${loadError ? ` (${loadError})` : ""}`);
          continue;
        }

        if (pdfPath) {
          try {
            const data = await extractFromPdf(pdfPath);
            const earningsValue = parseEarningsValue(data.earnings);
            if (STOP_ON_ZERO_EARNINGS && earningsValue === 0) {
              inactiveStudios.add(studio.name);
              console.log(`  ${studio.name}: earnings is 0; stop backfilling this location.`);
              continue;
            }
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
            console.log(`  ${studio.name}: extracted${fromCache ? " (cached PDF)" : ""}`);
          } catch (err) {
            console.log(`  ${studio.name}: extract failed`, err.message);
          }
        } else {
          console.log(`  ${studio.name}: no PDF`);
        }

        await new Promise((r) => setTimeout(r, STUDIO_DELAY_MS));
      }

      if (sessionExpired) break;

      if (!KEEP_PDFS) {
        for (const s of STUDIO_IDS) {
          const f = `${s.name}-${yyyy}-${mm}.pdf`;
          try {
            unlinkSync(join(DOWNLOADS_DIR, f));
          } catch (_) {}
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    const revenueData = {
      reportPeriod: BACKFILL_START,
      scrapedAt: new Date().toISOString(),
      extracted: allExtracted,
    };

    console.log("\nScraped", allExtracted.length, "rows.");

    if (hasBigQueryConfig) {
      const inserted = await uploadToBigQuery(revenueData);
      console.log("BigQuery: inserted", inserted, "row(s).");
    } else {
      console.log("Set BigQuery env vars and run npm run bigquery:upload to push to BigQuery.");
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
