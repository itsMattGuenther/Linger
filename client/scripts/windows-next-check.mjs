// The Buddy list client, in the packaged app's real WebView2 (T-1812): it
// starts signed in nowhere, draws its sign-in with its stylesheet, fonts and
// mark at every interface size, and a screenshot of it is kept as evidence.
// Launches only the packaged app windows-icon-check.ps1 installed, with an
// empty profile; no account, server or microphone is used.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32", "Run this check on an ephemeral Windows runner");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This check sets temporary machine policy on a disposable runner only");
const [exe, output] = process.argv.slice(2);
assert(exe && output, "Supply a packaged executable and empty evidence directory");
await mkdir(output, { recursive: true });
const listener = createServer();
await new Promise((settle) => listener.listen(0, "127.0.0.1", settle));
const port = listener.address().port;
await new Promise((settle) => listener.close(settle));
const endpoint = `http://127.0.0.1:${port}`;
const appName = basename(exe);
const policyKeys = [];
let app;
let browser;
try {
  // As windows-audio-check.mjs: HKLM app-specific WebView2 policy, removed after.
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
  const env = { ...process.env };
  delete env.LINGER_CLASSIC;
  app = spawn(resolve(exe), [], { stdio: "ignore", env });
  let launchError;
  app.on("error", (error) => { launchError = error; });
  let connectionError;
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    assert(!launchError, String(launchError));
    assert.equal(app.exitCode, null, `Packaged app exited: ${app.exitCode}`);
    try { browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 }); }
    catch (error) { connectionError = error; await new Promise((settle) => setTimeout(settle, 250)); }
  }
  assert(browser, `Packaged WebView2 debugging unavailable: ${connectionError}`);
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = context.pages().find((candidate) => candidate.url().startsWith("http://tauri.localhost"));
    if (!page) await new Promise((settle) => setTimeout(settle, 250));
  }
  assert(page, "Packaged application page missing from WebView2");
  await page.waitForLoadState("domcontentloaded");
  const probe = fileURLToPath(new URL("./next-smoke-probe.js", import.meta.url));
  await page.evaluate(await readFile(probe, "utf8"));
  await page.locator("#linger-audio-probe").click();
  await page.waitForFunction(() => window.__lingerAudioResult?.status !== "pending", undefined, { timeout: 60000 });
  const result = await page.evaluate(() => window.__lingerAudioResult);
  await page.screenshot({ path: resolve(output, "buddy-list-signin.png") });
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  assert.equal(result.status, "passed", JSON.stringify(result));
  console.log("PASS the Buddy list starts in packaged WebView2:", JSON.stringify(result.checks));
} finally {
  if (browser) await browser.close();
  if (app?.pid) {
    spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    if (app.exitCode === null) await new Promise((settle) => { app.once("exit", settle); setTimeout(settle, 10000); });
  }
  for (const key of policyKeys) {
    const removed = spawnSync("reg", ["delete", key, "/v", appName, "/f"], { encoding: "utf8" });
    assert.equal(removed.status, 0, `Could not remove test policy: ${removed.stderr}`);
  }
}

