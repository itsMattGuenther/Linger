// Exercise only Linger's shipped updater on a disposable Windows runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const [exe, output] = process.argv.slice(2);
assert(exe && output);
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const appName = basename(exe);
const policyKeys = [];
let app;
let browser;
try {
  for (const [setting, value] of [
    ["AdditionalBrowserArguments", `--remote-debugging-port=${port}`],
    ["UserDataFolder", resolve(output, "profile")],
  ]) {
    const key = `HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\${setting}`;
    assert.notEqual(spawnSync("reg", ["query", key, "/v", appName], { stdio: "ignore" }).status, 0);
    const changed = spawnSync("reg", ["add", key, "/v", appName, "/t", "REG_SZ", "/d", value, "/f"], { encoding: "utf8" });
    assert.equal(changed.status, 0, changed.stderr);
    policyKeys.push(key);
  }
  app = spawn(resolve(exe), [], { stdio: "ignore" });
  let launchError;
  app.on("error", (error) => { launchError = error; });
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    assert(!launchError, String(launchError));
    assert.equal(app.exitCode, null);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert(browser, "Packaged WebView2 debugging unavailable");
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = browser.contexts()[0].pages().find((candidate) => candidate.url().startsWith("http://tauri.localhost"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(page, "Packaged application page missing");
  await page.waitForLoadState("domcontentloaded");
  const version = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_version"));
  assert.equal(version, "0.3.0");
  const update = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_check"));
  console.log("Update check:", JSON.stringify(update));
  assert.equal(update.kind, "ready");
  assert.equal(update.version, "0.3.1", "This reproduction requires the 0.3.1 release");
  // A successful install exits this process before the invoke can resolve.
  page.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_install")).catch(() => {});
  for (let attempt = 0; attempt < 120 && app.exitCode === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.notEqual(app.exitCode, null, "Updater did not exit the old application");
  await browser.close();
  browser = undefined;
  // The installer takes over after the app exits. Wait for the installed file
  // version, then allow it to finish registering shortcuts and relaunching.
  let installed = "";
  for (let attempt = 0; attempt < 120 && !installed.startsWith("0.3.1"); attempt++) {
    const result = spawnSync("powershell", ["-NoProfile", "-Command",
      "(Get-Item -LiteralPath $env:LINGER_UPDATE_EXE).VersionInfo.ProductVersion"],
    { env: { ...process.env, LINGER_UPDATE_EXE: exe }, encoding: "utf8" });
    installed = result.stdout.trim();
    if (!installed.startsWith("0.3.1")) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(installed.startsWith("0.3.1"), `Original installation was not updated: ${installed}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("PASS installed version:", installed);
} finally {
  if (browser) await browser.close();
  if (app?.pid) spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  for (const key of policyKeys) {
    const removed = spawnSync("reg", ["delete", key, "/v", appName, "/f"], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
  }
}
