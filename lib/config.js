/**
 * Shared config: studio list, paths, date helpers.
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

export const COOKIES_FILE = resolve(ROOT, "cookies.json");
export const DOWNLOADS_DIR = resolve(ROOT, "reports-pdf");
export const LOGIN_URL = "https://studios.classpass.com/login";

export const STUDIO_IDS = [
  { name: "yorkville", studioId: "226136" },
  { name: "williamsburg", studioId: "260210" },
  { name: "flatiron", studioId: "235356" },
  { name: "adelaide", studioId: "192112" },
];

/** Studios with URLs for a given year/month. */
export function getStudios(year, month) {
  const y = String(year);
  const m = String(month).padStart(2, "0");
  return STUDIO_IDS.map((s) => ({
    ...s,
    url: `https://studios.classpass.com/reports/${s.studioId}/monthly/${y}/${m}`,
  }));
}

/** Months from startStr (YYYY-MM) through current month, inclusive. */
export function getMonthsToBackfill(startStr = "2022-08") {
  const [startYear, startMonth] = startStr.split("-").map(Number);
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;
  const out = [];
  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 1;
    const mEnd = y === endYear ? endMonth : 12;
    for (let m = mStart; m <= mEnd; m++) {
      out.push({ year: y, month: m });
    }
  }
  return out;
}

/** Last completed calendar month. */
export function getLastCompletedMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (month === 0) {
    return { year: year - 1, month: 12 };
  }
  return { year, month };
}
