// Launch only the packaged app selected by windows-icon-check.ps1.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { buildAudioProbe } from "./build-audio-probe.mjs";
import { chromium } from "@playwright/test";
import { seconds, whileRunning } from "./webview2-wait.mjs";

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
  app = spawn(resolve(exe), [], { stdio: "ignore" });
  // Every wait checks first that the app is still running (#814).
  const wait = whileRunning(app, "Packaged");
  // By the clock, not by counting tries: a refused try fails at once, so a
  // count of them was a far shorter wait than it looked, and a busy runner's
  // WebView2 outlasted it (#813, client/scripts/webview2-wait.mjs).
  const answered = await wait(`Packaged WebView2's debugging port didn't answer`,
    () => chromium.connectOverCDP(endpoint, { timeout: 1000 }));
  browser = answered.got;
  console.log(`Packaged WebView2 answered after ${seconds(answered.took)}`);
  const context = browser.contexts()[0];
  const { got: page } = await wait("Packaged application page missing from WebView2",
    () => context.pages().find((candidate) => candidate.url().startsWith("http://tauri.localhost")));
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
