/**
 * Cookie header and fetch-based PDF download.
 */
import { writeFileSync } from "fs";
import { USER_AGENT } from "./browser.js";

export function buildCookieHeader(cookies, host = "studios.classpass.com") {
  const domainMatch = (domain) => {
    const d = (domain || "").replace(/^\./, "");
    return host === d || host.endsWith("." + d);
  };
  const relevant = cookies.filter((c) => c.domain && domainMatch(c.domain));
  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function downloadPdfWithFetch(url, cookies, destPath) {
  const cookieHeader = buildCookieHeader(cookies);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookieHeader,
      Accept: "application/pdf,*/*",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  const isPdf = contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    const buf = await res.arrayBuffer();
    const first = new Uint8Array(buf, 0, 5);
    const pdfMagic = [0x25, 0x50, 0x44, 0x46];
    if (first.length >= 4 && pdfMagic.every((b, i) => first[i] === b)) {
      writeFileSync(destPath, Buffer.from(buf));
      return destPath;
    }
    return null;
  }
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
  return destPath;
}
