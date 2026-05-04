/**
 * Shared Puppeteer launch options and user agent.
 */
import { existsSync } from "fs";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SYSTEM_CHROME =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : null;

export function getLaunchOptions(headed = false) {
  const options = {
    headless: headed ? false : "new",
    defaultViewport: { width: 1280, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Reduce Chrome “Sign in to Google / turn on sync?” prompts that are not part of the page DOM.
      "--disable-sync",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-infobars",
      "--disable-features=ChromeSignin,ChromeSigninWithExplicitBrowserSignin",
    ],
  };
  if (SYSTEM_CHROME && existsSync(SYSTEM_CHROME)) {
    options.executablePath = SYSTEM_CHROME;
  }
  return options;
}

/**
 * Dismiss common blocking overlays (Google One Tap / FedCM-style prompts, generic modals).
 * Does not replace fixing Chrome profile sign-in UI (use launch flags above).
 */
export async function dismissGoogleOrSiteOverlays(page) {
  try {
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 200));
    }
    await page
      .evaluate(() => {
        const rx = /^(not now|no thanks|maybe later|close|dismiss|cancel)$/i;
        const candidates = Array.from(document.querySelectorAll("button, [role='button'], a"));
        for (const el of candidates) {
          const t = (el.textContent || el.getAttribute("aria-label") || "").trim();
          if (rx.test(t) && el.offsetParent !== null) {
            el.click();
            return;
          }
        }
      })
      .catch(() => {});
  } catch (_) {
    // ignore
  }
}

function skipGoogleAccountsGuards() {
  return process.env.SKIP_GOOGLE_ACCOUNTS_BLOCK === "1" || process.env.SKIP_GOOGLE_ACCOUNTS_BLOCK === "true";
}

function isGoogleAccountsNavUrl(url) {
  try {
    const u = new URL(url);
    if (/^accounts\.google\./i.test(u.hostname)) return true;
    if (/\.google\.com$/i.test(u.hostname) && /\/o\/oauth2\//i.test(u.pathname)) return true;
    return false;
  } catch {
    return /accounts\.google\./i.test(url);
  }
}

/**
 * Close extra tabs/windows that open Google's account sign-in (e.g. OAuth popups).
 * ClassPass email/password login does not need this flow; it blocks PDF/report automation.
 */
export function installGoogleAccountsPopupCloser(browser) {
  if (skipGoogleAccountsGuards()) return;

  browser.on("targetcreated", async (target) => {
    if (target.type() !== "page") return;
    const newPage = await target.page().catch(() => null);
    if (!newPage) return;

    const tryClose = async () => {
      try {
        const url = newPage.url();
        if (url && url !== "about:blank" && isGoogleAccountsNavUrl(url)) {
          await newPage.close({ runBeforeUnload: false }).catch(() => {});
        }
      } catch (_) {}
    };

    newPage.on("framenavigated", (frame) => {
      if (frame === newPage.mainFrame()) void tryClose();
    });
    for (const ms of [50, 200, 800, 2000]) {
      setTimeout(tryClose, ms);
    }
  });
}

/**
 * Block top-level navigations to accounts.google.com / OAuth on this page so the scraper
 * tab cannot be hijacked by "Sign in with Google" while ClassPass is already authenticated.
 * Set SKIP_GOOGLE_ACCOUNTS_BLOCK=1 to disable (e.g. if you must use Google SSO manually).
 */
export async function blockGoogleAccountsNavigations(page) {
  if (skipGoogleAccountsGuards()) return;

  let logged = false;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.isNavigationRequest() && isGoogleAccountsNavUrl(url)) {
      if (!logged) {
        logged = true;
        console.log(
          "Blocked navigation to Google Accounts (OAuth). Using ClassPass email/password only; close any sign-in tab if it already opened."
        );
      }
      req.abort("blockedbyclient").catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });
}
