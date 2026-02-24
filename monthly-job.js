/**
 * Monthly scheduled job: scrape the last completed month's stats and upload to BigQuery.
 * Runs scrape in-process (no file). Use with cron (e.g. 1st of each month).
 *
 * Usage: node monthly-job.js | npm run monthly
 * Requires: cookies.json. Optional: BigQuery env vars for upload.
 */

import "dotenv/config";
import { uploadToBigQuery } from "./upload-to-bigquery.js";
import { getLastCompletedMonth } from "./lib/config.js";

async function main() {
  const { year, month } = getLastCompletedMonth();
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const reportPeriod = `${yyyy}-${mm}`;

  console.log("Monthly job: last completed month =", reportPeriod);

  process.env.REPORT_YEAR = yyyy;
  process.env.REPORT_MONTH = mm;

  const { runReports } = await import("./scrape-with-cookies.js");
  const revenueData = await runReports();

  const withPeriod = {
    ...revenueData,
    extracted: (revenueData.extracted || []).map((row) => ({ ...row, reportPeriod })),
  };

  if (process.env.GOOGLE_CLOUD_PROJECT && process.env.BIGQUERY_DATASET && process.env.BIGQUERY_TABLE) {
    const inserted = await uploadToBigQuery(withPeriod);
    console.log("BigQuery: inserted", inserted, "row(s).");
  } else {
    console.log("BigQuery env not set. No upload.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
