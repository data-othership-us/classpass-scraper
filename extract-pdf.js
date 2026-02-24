/**
 * Extract key numbers from ClassPass monthly report PDFs.
 * PDF text format (from sample):
 *   Monthly Report
 *   February 2026
 *   Othership (Adelaide)
 *   Earnings*
 *   CA$6,790
 *   Reservations
 *   267
 *   Utilization
 *   28%
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// pdf-parse 1.x is CJS; use createRequire for ESM
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParseModule = require("pdf-parse");
const pdfParse = typeof pdfParseModule === "function" ? pdfParseModule : pdfParseModule.default;

/**
 * Parse report text (from PDF or from page body). Shared by PDF and in-browser extraction.
 * @param {string} text - Full text (PDF or document.body.innerText)
 * @returns {{ earnings?: string, currency?: string, reservations?: number, utilization?: string, studioName?: string, period?: string }}
 */
export function parseReportText(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Earnings: line starts with "Earnings" (optional *), next line is amount like "CA$6,790"
    if (/^Earnings\*?$/.test(line) && lines[i + 1]) {
      const amount = lines[i + 1].trim();
      const match = amount.match(/([A-Z]{2}\$|\$)\s*([\d,]+(?:\.\d{2})?)/);
      if (match) {
        result.currency = match[1].replace("$", "").trim() || "USD";
        result.earnings = amount;
      }
    }
    // Reservations: next line after "Reservations" is a number
    if (/^Reservations$/.test(line) && lines[i + 1]) {
      const num = lines[i + 1].replace(/,/g, "").trim();
      if (/^\d+$/.test(num)) result.reservations = parseInt(num, 10);
    }
    // Utilization: next line after "Utilization" is like "28%"
    if (/^Utilization$/.test(line) && lines[i + 1]) {
      const pct = lines[i + 1].trim();
      if (pct.endsWith("%")) result.utilization = pct;
    }
  }

  // Studio name: often line 3 (after "Monthly Report" and "February 2026")
  if (lines[0]?.toLowerCase().includes("monthly report") && lines[2]) {
    result.period = lines[1] || undefined;
    result.studioName = lines[2] || undefined;
  }

  // Fallback: regex on full text (handles web pages where label and value are on same line or different structure)
  const raw = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!result.earnings) {
    const m = raw.match(/Earnings\*?\s*([A-Z]{2}\$[\d,]+(?:\.[\d]{2})?|\$[\d,]+(?:\.[\d]{2})?)/i);
    if (m) {
      result.earnings = m[1].trim();
      const currencyMatch = result.earnings.match(/^([A-Z]{2})\$/);
      result.currency = currencyMatch ? currencyMatch[1] : "USD";
    }
  }
  if (result.reservations == null) {
    const m = raw.match(/Reservations\s*(\d[\d,]*)/i);
    if (m) result.reservations = parseInt(m[1].replace(/,/g, ""), 10);
  }
  if (!result.utilization) {
    const m = raw.match(/Utilization\s*(\d+%)/i);
    if (m) result.utilization = m[1];
  }
  if (!result.period) {
    const m = raw.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i);
    if (m) result.period = m[0];
  }

  return result;
}

/**
 * @param {string} pdfPath - Path to a single PDF file
 * @returns {Promise<object>} Parsed data + raw text snippet
 */
export async function extractFromPdf(pdfPath) {
  const buffer = readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const parsed = parseReportText(data.text || "");
  return {
    ...parsed,
    _source: pdfPath,
    _pages: data.numpages,
  };
}

/**
 * @param {string} dir - Directory containing PDF files
 * @param {string} [reportPeriod] - e.g. "2026-02" to match filenames
 * @returns {Promise<object[]>} Array of extracted data per PDF
 */
export async function extractAllFromDir(dir, reportPeriod) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const results = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const data = await extractFromPdf(path);
      results.push({ file, ...data });
    } catch (err) {
      results.push({ file, error: err.message });
    }
  }
  return results;
}

// CLI: node extract-pdf.js [path-to-pdf-or-dir]
if (process.argv[1] && process.argv[1].endsWith("extract-pdf.js")) {
  const pathArg = process.argv[2] || resolve(__dirname, "reports-pdf");
  (async () => {
    if (existsSync(pathArg)) {
      const stat = await import("fs").then((fs) => fs.promises.stat(pathArg));
      if (stat.isDirectory()) {
        const results = await extractAllFromDir(pathArg);
        console.log(JSON.stringify(results, null, 2));
      } else {
        const data = await extractFromPdf(pathArg);
        console.log(JSON.stringify(data, null, 2));
      }
    } else {
      console.error("Path not found:", pathArg);
      process.exit(1);
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
