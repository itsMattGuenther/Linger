// Connect only to the packaged app launched by windows-icon-check.ps1.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const endpoint = process.argv[2];
assert(endpoint?.startsWith("http://127.0.0.1:"), "A private app debugging endpoint is required");
let browser;
for (let attempt = 0; attempt < 60 && !browser; attempt++) {
  try { browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 }); }
  catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
}
assert(browser, "Packaged WebView2 did not start its debugging endpoint");
try {
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = context.pages().find((candidate) => candidate.url().startsWith("http://tauri.localhost"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(page, "Packaged application page missing from WebView2");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(await readFile(new URL("../../scripts/audio-runtime-probe.js", import.meta.url), "utf8"));
  await page.locator("#linger-audio-probe").click();
  await page.waitForFunction(() => window.__lingerAudioResult?.status !== "pending", undefined, { timeout: 10000 });
  const result = await page.evaluate(() => window.__lingerAudioResult);
  assert.equal(result.status, "passed", JSON.stringify(result));
  console.log("PASS packaged WebView2 realtime audio:", JSON.stringify(result));
} finally {
  await browser.close();
}
