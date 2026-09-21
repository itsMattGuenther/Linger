// Launch only the packaged app selected by windows-icon-check.ps1.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32", "Run this check on an ephemeral Windows runner");
const [exe, output] = process.argv.slice(2);
assert(exe && output, "Supply a packaged executable and empty evidence directory");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const app = spawn(resolve(exe), [], {
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: resolve(output, "profile"),
  },
});
let launchError;
app.on("error", (error) => { launchError = error; });
const endpoint = `http://127.0.0.1:${port}`;
let browser;
try {
  let connectionError;
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    assert(!launchError, String(launchError));
    assert.equal(app.exitCode, null, `Packaged app exited: ${app.exitCode}`);
    try { browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 }); }
    catch (error) { connectionError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert(browser, `Packaged WebView2 debugging unavailable: ${connectionError}`);
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
  if (browser) await browser.close();
  if (app.pid) spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
}
