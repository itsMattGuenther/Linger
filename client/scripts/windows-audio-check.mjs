// Launch only the packaged app selected by windows-icon-check.ps1.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { buildAudioProbe } from "./build-audio-probe.mjs";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32", "Run this check on an ephemeral Windows runner");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This check sets temporary machine policy on a disposable runner only");
const [exe, output] = process.argv.slice(2);
assert(exe && output, "Supply a packaged executable and empty evidence directory");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const appName = basename(exe);
const policyKeys = [];
let app;
let browser;
try {
  // WebView2 150+ ignores WEBVIEW2_* environment overrides in elevated apps.
  // GitHub's Windows runner is elevated. HKLM app-specific overrides remain
  // supported; never use a wildcard or alter the packaged application's code.
  for (const [setting, value] of [
    ["AdditionalBrowserArguments", `--remote-debugging-port=${port}`],
    ["UserDataFolder", resolve(output, "profile")],
  ]) {
    const key = `HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\${setting}`;
    assert.notEqual(spawnSync("reg", ["query", key, "/v", appName], { stdio: "ignore" }).status,
      0, `Refusing to replace an existing ${setting} policy for ${appName}`);
    const changed = spawnSync("reg", ["add", key, "/v", appName, "/t", "REG_SZ", "/d", value, "/f"], { encoding: "utf8" });
    assert.equal(changed.status, 0, changed.stderr);
    policyKeys.push(key);
  }
  // Today's client, the fallback that still ships (0.4.0): the layout probe
  // measures it against its own stylesheet. The audio is the same in either.
  app = spawn(resolve(exe), [], { stdio: "ignore", env: { ...process.env, LINGER_CLASSIC: "1" } });
  let launchError;
  app.on("error", (error) => { launchError = error; });
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
  const probe = resolve(output, "probe.js");
  await buildAudioProbe(probe);
  await page.evaluate(await readFile(probe, "utf8"));
  await page.locator("#linger-audio-probe").click();
  await page.waitForFunction(() => window.__lingerAudioResult?.status !== "pending", undefined, { timeout: 60000 });
  const result = await page.evaluate(() => window.__lingerAudioResult);
  assert.equal(result.status, "passed", JSON.stringify(result));
  await writeFile(resolve(output, "native-result.json"), JSON.stringify(result, null, 2));
  console.log("PASS packaged WebView2 realtime audio:", JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  if (app?.pid) {
    spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    // Only one Linger runs at a time: the next launch must not find this one.
    if (app.exitCode === null) await new Promise((settle) => { app.once("exit", settle); setTimeout(settle, 10000); });
  }
  for (const key of policyKeys) {
    const removed = spawnSync("reg", ["delete", key, "/v", appName, "/f"], { encoding: "utf8" });
    assert.equal(removed.status, 0, `Could not remove test policy: ${removed.stderr}`);
  }
}
