/**
 * ClassPass Studios – log in and save cookies for use with scrape-with-cookies.js
 *
 * Usage: npm run get-cookies | npm run get-cookies:headed
 */
import puppeteer from "puppeteer";
import { existsSync, writeFileSync } from "fs";
import "dotenv/config";
import { COOKIES_FILE, LOGIN_URL } from "./lib/config.js";
import {
  getLaunchOptions,
  USER_AGENT,
  installGoogleAccountsPopupCloser,
  blockGoogleAccountsNavigations,
} from "./lib/browser.js";

const EMAIL = process.env.CLASSPASS_EMAIL;
const PASSWORD = process.env.CLASSPASS_PASSWORD;
const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";

if (!EMAIL || !PASSWORD) {
  console.error("Set CLASSPASS_EMAIL and CLASSPASS_PASSWORD in .env");
  process.exit(1);
}

async function main() {
  const browser = await puppeteer.launch(getLaunchOptions(HEADED));
  installGoogleAccountsPopupCloser(browser);
  const page = await browser.newPage();
  await blockGoogleAccountsNavigations(page);
  await page.setUserAgent(USER_AGENT);

  try {
    console.log("Navigating to ClassPass login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch((e) => {
      if (e?.message?.includes("Timeout")) console.warn("Navigation warning:", e.message);
      else throw e;
    });

    const loginFormSelector = 'form[data-cypress="login-form"]';
    await page.waitForSelector(loginFormSelector, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));

    const emailInput =
      (await page.$(`${loginFormSelector} input[name="email"]`)) ||
      (await page.$(`${loginFormSelector} input[type="email"]`));
    const passwordInput =
      (await page.$(`${loginFormSelector} input[name="password"]`)) ||
      (await page.$(`${loginFormSelector} input[type="password"]`));
    if (!emailInput || !passwordInput) {
      throw new Error("Could not find email or password fields.");
    }

    await emailInput.type(EMAIL, { delay: 50 });
    await passwordInput.type(PASSWORD, { delay: 50 });

    console.log("Email and password filled. Click the Log in button in the browser (or wait for redirect)...");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});

    const currentUrl = page.url();
    console.log("Post-login URL:", currentUrl);

    if (currentUrl.includes("/login")) {
      const errMsg = await page.$eval("body", (el) => el.innerText).catch(() => "");
      if (errMsg.toLowerCase().includes("invalid") || errMsg.toLowerCase().includes("incorrect")) {
        throw new Error("Login failed: invalid credentials.");
      }
      console.warn("Still on login page. Complete CAPTCHA if shown, then click Log in.");
      process.exit(1);
    }

    const cookies = await page.cookies();
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log("Saved cookies to", COOKIES_FILE);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
