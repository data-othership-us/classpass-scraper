/**
 * Shared logic: try to download a report PDF for one studio (one URL).
 * Returns { pdfPath, sessionExpired }.
 */
import { readdirSync, renameSync } from "fs";
import { join, basename } from "path";
import { downloadPdfWithFetch } from "./cookies.js";

export async function tryDownloadPdfForStudio(page, studio, year, month, cookies, existingFiles, downloadsDir) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const filesBeforeNavigate = new Set(readdirSync(downloadsDir));

  const res = await page.goto(studio.url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
  if (!res || res.status() !== 200) {
    return { pdfPath: null, sessionExpired: false, loadFailed: true };
  }
  if (page.url().includes("/login")) {
    return { pdfPath: null, sessionExpired: true, loadFailed: false };
  }

  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1000))).catch(() => {});

  let pdfPath = null;
  const destPdf = join(downloadsDir, `${studio.name}-${yyyy}-${mm}.pdf`);

  const afterNavigate = readdirSync(downloadsDir);
  const newPdfFromNavigate = afterNavigate.find((f) => f.endsWith(".pdf") && !filesBeforeNavigate.has(f) && !existingFiles.has(f));
  if (newPdfFromNavigate) {
    pdfPath = join(downloadsDir, newPdfFromNavigate);
    try {
      renameSync(pdfPath, destPdf);
      pdfPath = destPdf;
    } catch (_) {}
    existingFiles.add(basename(destPdf));
  }

  await new Promise((r) => setTimeout(r, 500));

  if (!pdfPath) {
    try {
      const saved = await downloadPdfWithFetch(studio.url, cookies, destPdf);
      if (saved) {
        pdfPath = saved;
        existingFiles.add(`${studio.name}-${yyyy}-${mm}.pdf`);
      }
    } catch (_) {}
  }

  if (!pdfPath) {
    const downloadLink = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="pdf"], a[href*="download"], a[download], a[href$=".pdf"]');
      for (const a of links) {
        const href = (a.getAttribute("href") || "").toLowerCase();
        const text = (a.textContent || "").toLowerCase();
        if (href.includes("pdf") || href.includes("download") || text.includes("pdf") || text.includes("download")) {
          return a.href || null;
        }
      }
      return null;
    });
    if (downloadLink) {
      const beforeFiles = new Set(readdirSync(downloadsDir));
      await page.goto(downloadLink, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      const afterFiles = readdirSync(downloadsDir);
      const newPdf = afterFiles.find((f) => f.endsWith(".pdf") && !beforeFiles.has(f) && !existingFiles.has(f));
      if (newPdf) {
        pdfPath = join(downloadsDir, newPdf);
        const renamed = `${studio.name}-${yyyy}-${mm}.pdf`;
        const dest = join(downloadsDir, renamed);
        try {
          renameSync(pdfPath, dest);
          pdfPath = dest;
        } catch (_) {}
        existingFiles.add(renamed);
      }
    }
  }

  if (!pdfPath) {
    await new Promise((r) => setTimeout(r, 2000));
    const findAndClickDownload = () => {
      const selectors = ['#save', 'cr-icon-button#save', 'cr-icon-button[aria-label="Download"]', '[title="Download"]'];
      function searchRoot(root) {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          if (el) return el;
        }
        for (const node of root.querySelectorAll("*")) {
          if (node.shadowRoot) {
            const found = searchRoot(node.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      const el = searchRoot(document.body);
      if (el) {
        el.click();
        return true;
      }
      const fallback =
        document.querySelector('a[href*="pdf"]') ||
        document.querySelector('a[download]') ||
        document.querySelector('[aria-label*="download" i]') ||
        Array.from(document.querySelectorAll("a, button, [role='button']")).find((e) =>
          /download|pdf|export/i.test((e.textContent || e.getAttribute("aria-label") || ""))
        );
      if (fallback) {
        fallback.click();
        return true;
      }
      return false;
    };
    let clicked = false;
    for (const frame of page.frames()) {
      try {
        clicked = await frame.evaluate(findAndClickDownload);
        if (clicked) break;
      } catch (_) {}
    }
    if (clicked) {
      await new Promise((r) => setTimeout(r, 5000));
      const afterFiles = readdirSync(downloadsDir);
      const newPdf = afterFiles.find((f) => f.endsWith(".pdf") && !existingFiles.has(f));
      if (newPdf) {
        pdfPath = join(downloadsDir, newPdf);
        const renamed = `${studio.name}-${yyyy}-${mm}.pdf`;
        const dest = join(downloadsDir, renamed);
        try {
          renameSync(pdfPath, dest);
          pdfPath = dest;
        } catch (_) {}
        existingFiles.add(renamed);
      }
    }
  }

  return { pdfPath, sessionExpired: false, loadFailed: false };
}
