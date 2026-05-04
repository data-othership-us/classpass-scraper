/**
 * Shared logic: try to download a report PDF for one studio (one URL).
 * Returns { pdfPath, sessionExpired }.
 */
import { readdirSync, renameSync } from "fs";
import { join, basename } from "path";
import { downloadPdfWithFetch } from "./cookies.js";
import { dismissGoogleOrSiteOverlays } from "./browser.js";

export async function tryDownloadPdfForStudio(page, studio, year, month, cookies, existingFiles, downloadsDir, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 45000);
  const maxAttempts = Number(options.maxAttempts ?? 2);
  const retryDelayMs = Number(options.retryDelayMs ?? 7000);
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const filesBeforeNavigate = new Set(readdirSync(downloadsDir));

  let res = null;
  let lastLoadError = "Navigation failed (no HTTP response).";
  let lastStatus = null;
  let lastUrl = "";
  let lastTitle = "";
  let lastGotoError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await page
      .goto(studio.url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
      .catch((err) => {
        lastGotoError = err?.message || "";
        return null;
      });
    lastUrl = page.url();
    lastTitle = await page.title().catch(() => "");
    if (!res) {
      lastStatus = null;
      const looksLikeChallenge = /just a moment|challenge/i.test(lastTitle) || lastUrl.includes("__cf_chl");
      lastLoadError = looksLikeChallenge
        ? `Navigation failed behind Cloudflare challenge (url=${lastUrl || "n/a"}, title=${lastTitle || "n/a"}).`
        : `Navigation failed (no HTTP response, url=${lastUrl || "n/a"}, title=${lastTitle || "n/a"}${
            lastGotoError ? `, gotoError=${lastGotoError}` : ""
          }).`;
    } else if (lastUrl.includes("/login")) {
      return { pdfPath: null, sessionExpired: true, loadFailed: false };
    } else {
      const status = res.status();
      lastStatus = status;
      if (status < 400) {
        break;
      }
      const blockedByChallenge =
        status === 403 &&
        (lastUrl.includes("__cf_chl") || /just a moment/i.test(lastTitle));
      lastLoadError = blockedByChallenge
        ? `Blocked by Cloudflare challenge (HTTP 403, url=${lastUrl || "n/a"}, title=${lastTitle || "n/a"}).`
        : `HTTP ${status} while loading report page (url=${lastUrl || "n/a"}, title=${lastTitle || "n/a"}).`;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  if (!res) {
    return { pdfPath: null, sessionExpired: false, loadFailed: true, loadError: lastLoadError, statusCode: lastStatus };
  }
  if (res.status() >= 400) {
    return { pdfPath: null, sessionExpired: false, loadFailed: true, loadError: lastLoadError, statusCode: lastStatus };
  }

  await dismissGoogleOrSiteOverlays(page);

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
      const drivePattern = /google\s*drive|save\s+to\s+drive|add\s+to\s+drive|^drive$/i;

      function controlLabel(el) {
        return (
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("data-tooltip") ||
          ""
        ).trim();
      }

      function isGoogleDriveControl(el) {
        const t = controlLabel(el).toLowerCase();
        if (drivePattern.test(t)) return true;
        if (/\bdrive\b/i.test(t) && /google/i.test(t)) return true;
        return false;
      }

      function isDownloadControl(el) {
        if (isGoogleDriveControl(el)) return false;
        const t = controlLabel(el).toLowerCase();
        if (!t) return false;
        if (t === "download") return true;
        if (/^download\b/i.test(t) && !/drive/i.test(t)) return true;
        return false;
      }

      /** Prefer the Chrome PDF toolbar “Download” icon; never the adjacent “Google Drive” icon. */
      function pickDownloadInRoot(root) {
        const candidates = [];
        function collect(r) {
          r.querySelectorAll("cr-icon-button, button, [role='button']").forEach((el) => candidates.push(el));
          r.querySelectorAll("*").forEach((node) => {
            if (node.shadowRoot) collect(node.shadowRoot);
          });
        }
        collect(root);

        for (const el of candidates) {
          if (isDownloadControl(el)) return el;
        }

        for (const sel of ['cr-icon-button[aria-label="Download"]', '[title="Download"]']) {
          const el = root.querySelector(sel);
          if (el && isDownloadControl(el)) return el;
        }

        const legacySave = root.querySelector("#save, cr-icon-button#save");
        if (legacySave && !isGoogleDriveControl(legacySave)) {
          const lbl = controlLabel(legacySave);
          if (!lbl || isDownloadControl(legacySave)) return legacySave;
        }
        return null;
      }

      const el = pickDownloadInRoot(document.body);
      if (el) {
        el.click();
        return true;
      }
      const fallback =
        document.querySelector('a[href*="pdf"]') ||
        document.querySelector('a[download]') ||
        document.querySelector('[aria-label^="Download" i]:not([aria-label*="Drive" i])') ||
        Array.from(document.querySelectorAll("a, button, [role='button']")).find((e) => {
          if (isGoogleDriveControl(e)) return false;
          return /^(download|save\s+as)$/i.test(controlLabel(e));
        });
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
