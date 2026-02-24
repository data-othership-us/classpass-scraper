# ClassPass Studios Revenue Scraper

Uses [Puppeteer](https://pptr.dev/) to log in to the ClassPass Partner Dashboard and scrape monthly revenue data.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure credentials**

   Copy the example env file and add your ClassPass Studios login:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:

   - `CLASSPASS_EMAIL` – your partner account email
   - `CLASSPASS_PASSWORD` – your password

   Or set them in the environment:

   ```bash
   export CLASSPASS_EMAIL=you@example.com
   export CLASSPASS_PASSWORD=yourpassword
   ```

## Usage

- **First time (or when cookies expired):** run with a visible browser, log in, and save cookies:

  ```bash
  npm run get-cookies:headed
  ```

  After a successful login the script writes `cookies.json`. Use that for the report scraper.

- **Scrape reports (with saved cookies):** run the cookie-based scraper; it loads `cookies.json` and visits each report URL to download PDFs:

  ```bash
  npm run reports
  ```

Scraped data is printed to the console. PDFs are saved under `reports-pdf/`. There is no `revenue-data.json` file; when BigQuery env is set, data is uploaded in-process (see below).

## Pipeline (scrape → download PDFs → extract)

Both the main scraper and the cookie-based scraper run the same two steps in one go:

1. **Step 1: Scrape and download PDFs** – Visit each studio’s report page and download the monthly report PDF into `reports-pdf/`.
2. **Step 2: Extract** – Read every PDF in `reports-pdf/`, parse earnings/reservations/utilization (in memory).

**One command (after you have cookies):** download PDFs and extract in a single run:

```bash
npm run reports          # headless
npm run reports:headed   # with browser
```

**Extract only** (when you already have PDFs in `reports-pdf/`):

```bash
node extract-pdf.js                    # all PDFs in reports-pdf/
node extract-pdf.js /path/to/file.pdf  # single file
```

Extracted rows (in memory) look like:

```json
"extracted": [
  { "file": "adelaide-2026-02.pdf", "studio": "adelaide", "earnings": "CA$6,790", "reservations": 267, "utilization": "28%", "period": "February 2026" }
]
```

If the report page doesn’t have a visible “Download PDF” link, the script will still run extraction on any PDFs already in `reports-pdf/` (e.g. after you download them manually once).

## BigQuery and monthly job

Upload to BigQuery is **in-process only**: there is no standalone "upload only" step. Set in `.env`:

- `GOOGLE_CLOUD_PROJECT`, `BIGQUERY_DATASET`, `BIGQUERY_TABLE`
- Optionally `GOOGLE_APPLICATION_CREDENTIALS` (path to service account JSON)

Then:

- **`npm run reports`** – Scrapes the month from `REPORT_YEAR`/`REPORT_MONTH` (or current month), then uploads if BigQuery env is set.
- **`npm run monthly`** – Runs the **monthly job**: scrapes the last completed month in-process and passes the result straight into `uploadToBigQuery` (no file). Use with cron (e.g. 1st of each month).
- **`npm run backfill`** – Backfills from `BACKFILL_START` (default `2022-08`) to current; uploads after each month.

## Project structure

- **`lib/`** – Shared code: `config.js` (studios, paths, date helpers), `browser.js` (Puppeteer launch), `cookies.js` (cookie header + fetch PDF), `pdf-download.js` (one-studio download flow).
- **Entry scripts** – `get-cookies.js`, `scrape-with-cookies.js`, `backfill.js`, `monthly-job.js`, `upload-to-bigquery.js`, `extract-pdf.js`. `.env` is loaded via `dotenv` in each script that needs it.

## Requirements

- Node.js 18+
- Valid ClassPass Studios (partner) account
