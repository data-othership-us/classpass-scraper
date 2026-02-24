/**
 * Insert revenue data into BigQuery. Transform in-memory revenueData and insert.
 * Called by scrape-with-cookies, monthly-job, and backfill (no file). Upload-only is not supported.
 *
 * Requires in .env: GOOGLE_CLOUD_PROJECT, BIGQUERY_DATASET, BIGQUERY_TABLE
 * Optional: GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)
 */
import { resolve } from "path";
import { fileURLToPath } from "url";
import { BigQuery } from "@google-cloud/bigquery";
import "dotenv/config";

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Parse period or report_period into a TIMESTAMP for BigQuery (first day of month, UTC).
 * @param {string} [period] - e.g. "January 2026"
 * @param {string} [reportPeriod] - e.g. "2026-01"
 * @returns {string|null} ISO timestamp or null
 */
function parseMonthTimestamp(period, reportPeriodStr) {
  if (reportPeriodStr && /^\d{4}-\d{2}$/.test(reportPeriodStr)) {
    const [y, m] = reportPeriodStr.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    return d.toISOString();
  }
  if (period && typeof period === "string") {
    const match = period.trim().match(/^(\w+)\s+(\d{4})$/i);
    if (match) {
      const monthName = match[1].toLowerCase();
      const year = parseInt(match[2], 10);
      const monthIndex = MONTH_NAMES.indexOf(monthName);
      if (monthIndex >= 0) {
        const d = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
        return d.toISOString();
      }
    }
  }
  return null;
}

/**
 * Parse earnings string to float: "$26,826" or "CA$27,464" -> 26826, 27464
 */
function parseEarnings(earningsStr) {
  if (earningsStr == null || typeof earningsStr !== "string") return null;
  const cleaned = earningsStr.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse utilization string to float: "50%" -> 50
 */
function parseUtilization(utilStr) {
  if (utilStr == null) return null;
  if (typeof utilStr === "number" && Number.isFinite(utilStr)) return utilStr;
  if (typeof utilStr === "string") {
    const cleaned = utilStr.replace(/%/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Map one item from revenueData.extracted to your BigQuery row schema:
 * month, location, earnings, currency, reservation, utilization, inserted_at
 */
function toBigQueryRow(row, reportPeriodStr, scrapedAtStr) {
  const month = parseMonthTimestamp(row.period, reportPeriodStr);
  const location = row.studio ?? null;
  const earnings = parseEarnings(row.earnings);
  const currencyRaw = row.currency ?? null;
  const currency = currencyRaw === "CA" ? "CAD" : currencyRaw;
  const reservation = row.reservations != null ? row.reservations : null;
  const utilization = parseUtilization(row.utilization);
  const inserted_at = scrapedAtStr;

  // Only insert rows with at least one metric (skip page-only extractions that have studio but no numbers)
  if (earnings == null && reservation == null && utilization == null) {
    return null;
  }

  return {
    month: month || undefined,
    location: location || undefined,
    earnings: earnings ?? undefined,
    currency: currency || undefined,
    reservation: reservation ?? undefined,
    utilization: utilization ?? undefined,
    inserted_at,
  };
}

/**
 * Transform and insert revenue data into BigQuery. Call with the same object
 * you have in memory (reportPeriod, scrapedAt, extracted).
 * @param {{ reportPeriod?: string, scrapedAt?: string, extracted?: object[] }} revenueData
 * @returns {Promise<number>} Number of rows inserted
 */
export async function uploadToBigQuery(revenueData) {
  const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
  const DATASET_ID = process.env.BIGQUERY_DATASET;
  const TABLE_ID = process.env.BIGQUERY_TABLE;

  if (!PROJECT_ID || !DATASET_ID || !TABLE_ID) {
    throw new Error("Set GOOGLE_CLOUD_PROJECT, BIGQUERY_DATASET, and BIGQUERY_TABLE.");
  }

  const reportPeriod = revenueData.reportPeriod || "";
  const scrapedAt = revenueData.scrapedAt || new Date().toISOString();
  const extracted = revenueData.extracted || [];

  console.log("Extracted items:");
  extracted.forEach((row, i) => {
    console.log(`  [${i}] source=${row.source} file=${row.file ?? "(none)"} studio="${row.studio ?? ""}" earnings=${row.earnings ?? "null"} reservations=${row.reservations ?? "null"} utilization=${row.utilization ?? "null"}`);
  });

  const rows = extracted
    .map((row) => toBigQueryRow(row, row.reportPeriod ?? reportPeriod, scrapedAt))
    .filter(Boolean);

  console.log("\nRows to insert (after filter: need earnings/reservation/utilization):");
  rows.forEach((r, i) => {
    console.log(`  [${i}] location="${r.location}" earnings=${r.earnings} reservation=${r.reservation} utilization=${r.utilization} currency=${r.currency}`);
  });

  if (rows.length === 0) {
    return 0;
  }

  const bigquery = new BigQuery({ projectId: PROJECT_ID });
  const table = bigquery.dataset(DATASET_ID).table(TABLE_ID);
  await table.insert(rows);
  return rows.length;
}

// When run as script: no file; upload only happens as part of scrape/monthly/backfill
const scriptPath = resolve(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && resolve(process.argv[1]) === scriptPath;
if (isMain) {
  console.log("Upload-only is not supported. Run: npm run reports | npm run monthly | npm run backfill");
  process.exit(0);
}
