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
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
  if (SYSTEM_CHROME && existsSync(SYSTEM_CHROME)) {
    options.executablePath = SYSTEM_CHROME;
  }
  return options;
}
