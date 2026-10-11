// A Linger window nobody can see stops its page drawing, on Windows (#594).
//
// WebView2 sits in Linger's window as a child window and is never told that
// its window was minimized or hidden, so without the shell's help the page
// keeps drawing every animation for nobody. The shell sets the WebView's
// IsVisible (window.rs `page_seen`). This check does to the installed app's
// list window what a person does (minimize it, restore it, close it to the
// tray, start Linger again to bring it back) and, at each step, reads:
//
// - whether WebView2 has switched its own windows inside Linger's off;
// - the frames the page draws, with a busy canvas on it, and the page's own
//   busy time (Chromium's TaskDuration over the debugging port): none of
//   either while minimized or in the tray;
// - that an event from the shell still reaches the hidden page at once:
//   messages from a server reach the page the same way (`gateway:frame`),
//   though no server runs here;
// - that after each return the page draws again and the window isn't blank
//   (a capture of the window itself, and the page's screenshot, are kept).
//
// What it found, 2026-10-11: WebView2 never changes the page's
// `document.visibilityState` (it stays "visible", no `visibilitychange`), and
// timers aren't slowed; it stops drawing. That's recorded, not asserted.
//
// Runs on a disposable Windows runner only, after windows-icon-check.ps1 has
// installed the app; launches only that app, with an empty profile and no
// account. The Win32 half is windows-window.ps1. Usage:
//   node client/scripts/windows-hidden-check.mjs <installed exe> <evidence dir>
import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32", "Run this check on an ephemeral Windows runner");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This check sets temporary machine policy on a disposable runner only");
const [exe, output] = process.argv.slice(2);
assert(exe && output, "Supply the installed executable and an empty evidence directory");
await mkdir(output, { recursive: true });

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** Each step's verdict; the check fails at the end if any did, so one run shows them all. */
const results = [];
function verdict(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${JSON.stringify(detail)}`);
  return ok;
}
const note = (what) => console.log(`NOTE ${what}`);

// The Win32 helper, one PowerShell for the whole run.
const helper = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./windows-window.ps1", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = [];
createInterface({ input: helper.stdout }).on("line", (line) => {
  if (!line.startsWith("LINGER-REPLY ")) return;
  replies.shift()?.(JSON.parse(line.slice("LINGER-REPLY ".length)));
});
/** One Win32 step, answered within 60 s or failed. */
function win(op, args = {}) {
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`${op} got no answer within 60 s`)), 60000);
    replies.push((reply) => {
      clearTimeout(timer);
      if (reply.error) fail(new Error(`${op}: ${reply.error}`));
      else settle(reply);
    });
    helper.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
  });
}

const listener = createServer();
await new Promise((settle) => listener.listen(0, "127.0.0.1", settle));
const port = listener.address().port;
await new Promise((settle) => listener.close(settle));
const appName = basename(exe);
const policyKeys = [];
let app;
let browser;
try {
  // As windows-next-check.mjs: HKLM app-specific WebView2 policy (WebView2
  // ignores WEBVIEW2_* variables in an elevated app, and the runner is
  // elevated), removed again at the end. Never a wildcard.
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
  const log = openSync(resolve(output, "app.log"), "w");
  app = spawn(resolve(exe), [], { stdio: ["ignore", log, log] });
  closeSync(log);
  let launchError;
  app.on("error", (error) => { launchError = error; });
  let connectionError;
  for (let attempt = 0; attempt < 120 && !browser; attempt++) {
    assert(!launchError, String(launchError));
    assert.equal(app.exitCode, null, `Installed app exited: ${app.exitCode}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch (error) { connectionError = error; await sleep(250); }
  }
  assert(browser, `Installed WebView2 debugging unavailable: ${connectionError}`);
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    // The list window's page; the others carry `window=` in their address.
    page = context.pages().find((candidate) => candidate.url().startsWith("http://tauri.localhost") && !candidate.url().includes("window="));
    if (!page) await sleep(250);
  }
  assert(page, "The list window's page is missing from WebView2");
  await page.waitForLoadState("domcontentloaded");

  let hwnd = 0;
  for (let attempt = 0; attempt < 120 && !hwnd; attempt++) {
    const found = await win("main", { pid: app.pid });
    assert(!found.exited, "Installed app exited before showing its window");
    hwnd = found.hwnd;
    if (!hwnd) await sleep(250);
  }
  assert(hwnd, "The installed app never showed a window");

  // A frame counter, every visibility change the page hears, and a busy
  // canvas to give WebView2 something to draw.
  await page.evaluate(() => {
    const check = { frames: 0, busy: false, changes: [] };
    document.addEventListener("visibilitychange", () => check.changes.push(document.visibilityState));
    const count = () => { check.frames++; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    Object.assign(canvas.style, {
      position: "fixed", left: "0", top: "0", width: "240px", height: "150px",
      opacity: "0.05", pointerEvents: "none", zIndex: "2147483647", display: "none",
    });
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    const draw = (t) => {
      if (!check.busy) return;
      for (let i = 0; i < 300; i++) {
        g.fillStyle = `hsl(${(t / 4 + i * 7) % 360} 70% 50%)`;
        g.beginPath();
        g.arc((i * 53 + t / 2) % 960, (i * 31 + t / 3) % 600, 20 + (i % 30), 0, Math.PI * 2);
        g.fill();
      }
      requestAnimationFrame(draw);
    };
    check.start = () => {
      if (check.busy) return;
      check.busy = true;
      canvas.style.display = "block";
      requestAnimationFrame(draw);
    };
    // Gone before every capture, so it can't make a blank window look drawn.
    check.stop = () => { check.busy = false; canvas.style.display = "none"; };
    window.__lingerHiddenCheck = check;
  });

  // The page's own busy time, straight from the renderer: Chromium's
  // TaskDuration, everything its main thread did, drawing included.
  const devtools = await context.newCDPSession(page);
  await devtools.send("Performance.enable");
  const busySeconds = async () => (await devtools.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;

  /** With the canvas busy: the frames drawn and the page's busy seconds over `ms`. */
  async function measure(ms) {
    await page.evaluate(() => window.__lingerHiddenCheck.start());
    const frames0 = await page.evaluate(() => window.__lingerHiddenCheck.frames);
    const busy0 = await busySeconds();
    const t0 = Date.now();
    await sleep(ms);
    const busy1 = await busySeconds();
    const frames1 = await page.evaluate(() => window.__lingerHiddenCheck.frames);
    return { seconds: (Date.now() - t0) / 1000, frames: frames1 - frames0, pageBusy: Number((busy1 - busy0).toFixed(3)) };
  }

  /** The window's state, and whether WebView2 has switched its own windows inside it off. */
  async function inside() {
    const state = await win("state", { hwnd });
    return { ...state, webviewOff: state.innerSetToShow < state.inner };
  }

  /** Waits up to `ms` for WebView2 to switch its windows off (or back on). */
  async function webviewBecomes(off, ms = 10000) {
    const until = Date.now() + ms;
    let now = await inside();
    while (now.webviewOff !== off && Date.now() < until) {
      await sleep(100);
      now = await inside();
    }
    return now;
  }

  /** Milliseconds for an event the page emits to come back to it through the shell, `n` times. */
  const roundTrips = (n) =>
    page.evaluate(async (count) => {
      const tauri = window.__TAURI_INTERNALS__;
      let arrived = () => {};
      const handler = tauri.transformCallback(() => arrived());
      const id = await tauri.invoke("plugin:event|listen", { event: "linger-check:ping", target: { kind: "Any" }, handler });
      const times = [];
      try {
        for (let i = 0; i < count; i++) {
          const t0 = performance.now();
          const back = new Promise((settle) => { arrived = settle; });
          await tauri.invoke("plugin:event|emit", { event: "linger-check:ping", payload: i });
          await Promise.race([back, new Promise((settle) => setTimeout(settle, 10000))]);
          times.push(Math.round(performance.now() - t0));
        }
      } finally {
        await tauri.invoke("plugin:event|unlisten", { event: "linger-check:ping", eventId: id });
      }
      return times;
    }, n);

  /** How late a 100 ms timer fires, for the record. */
  const timerLateness = () =>
    page.evaluate(() => new Promise((settle) => {
      const t0 = performance.now();
      setTimeout(() => settle(Math.round(performance.now() - t0 - 100)), 100);
    }));

  /** Shown again: WebView2 is back on, the page draws, and the window isn't blank. */
  async function back(name) {
    const state = await webviewBecomes(false);
    verdict(`${name}: WebView2 is switched back on`, !state.webviewOff && state.visible && !state.minimized, state);
    const drawing = await measure(2000);
    verdict(`${name}: the page draws again`, drawing.frames >= 10, drawing);
    await page.evaluate(() => window.__lingerHiddenCheck.stop());
    // Two frames, so what's captured is what the page draws now; a page that
    // draws nothing gets three seconds, then is captured as it is.
    await page.evaluate(() => new Promise((settle) => {
      requestAnimationFrame(() => requestAnimationFrame(settle));
      setTimeout(settle, 3000);
    }));
    await sleep(500);
    const printed = await win("capture", { hwnd, path: resolve(output, `${name}-window.png`), how: "print" });
    const screen = await win("capture", { hwnd, path: resolve(output, `${name}-screen.png`), how: "screen" });
    await page.screenshot({ path: resolve(output, `${name}-page.png`), timeout: 15000 }).catch(() => undefined);
    // PrintWindow asks the window to draw itself, WebView2's content included,
    // whatever is in front of it; the screen copy is the fallback if it can't.
    const used = printed.ok ? printed : screen;
    verdict(`${name}: the window is drawn, not blank`, used.ok && used.dominant < 0.995, { printed, screen });
  }

  // 1. Shown.
  const atStart = await inside();
  verdict("shown at start: WebView2 is on", !atStart.webviewOff && atStart.visible, atStart);
  const shown = await measure(3000);
  verdict("shown: the page draws, and is busy with the canvas", shown.frames >= 15 && shown.pageBusy >= 0.1, shown);

  // 2. Minimized: off, not drawing, not busy; events still arrive.
  await win("minimize", { hwnd });
  const minimized = await webviewBecomes(true);
  verdict("minimized: WebView2 is switched off", minimized.webviewOff && minimized.minimized, minimized);
  const whileMinimized = await measure(3000);
  verdict("minimized: the page draws nothing", whileMinimized.frames <= 3, whileMinimized);
  verdict("minimized: the page is far less busy than shown", whileMinimized.pageBusy <= shown.pageBusy * 0.25,
    { shown: shown.pageBusy, minimized: whileMinimized.pageBusy });
  const trips = await roundTrips(5);
  verdict("minimized: an event from the shell reaches the page at once", trips.length === 5 && Math.max(...trips) < 1000, { milliseconds: trips });
  note(`while minimized the page says it's "${await page.evaluate(() => document.visibilityState)}", and a 100 ms timer fired ${await timerLateness()} ms late`);

  // 3. Restored.
  await win("restore", { hwnd });
  await back("restored");

  // 4. Closed to the tray: still running, off, not drawing, not busy.
  const beforeTray = await measure(2000);
  await win("close", { hwnd });
  const inTray = await webviewBecomes(true);
  verdict("in the tray: Linger still runs, its window hidden and WebView2 off",
    app.exitCode === null && !inTray.visible && inTray.webviewOff, { exitCode: app.exitCode, ...inTray });
  const whileInTray = await measure(3000);
  verdict("in the tray: the page draws nothing", whileInTray.frames <= 3, whileInTray);
  verdict("in the tray: the page is far less busy than shown", whileInTray.pageBusy <= beforeTray.pageBusy * 0.25,
    { shown: beforeTray.pageBusy, inTray: whileInTray.pageBusy });
  // Still off a few seconds later: nothing switched it back on (#594's focus loop).
  await sleep(2000);
  const stillInTray = await inside();
  verdict("in the tray: WebView2 stays off", stillInTray.webviewOff, stillInTray);

  // 5. Back from the tray: starting Linger again brings the list back, through
  // the same shell function as the tray's Show Linger (tray::show_list).
  const again = spawn(resolve(exe), [], { stdio: "ignore" });
  const againExit = await Promise.race([new Promise((settle) => again.once("exit", settle)), sleep(30000).then(() => "still running")]);
  note(`the second launch handed over and ended with ${againExit}`);
  await back("from-tray");

  note(`visibility changes the page heard: ${JSON.stringify(await page.evaluate(() => window.__lingerHiddenCheck.changes))}`);
} catch (error) {
  verdict("the check ran to the end", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (app?.pid) {
    spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    // Only one Linger runs at a time: the next launch must not find this one.
    if (app.exitCode === null) await new Promise((settle) => { app.once("exit", settle); setTimeout(settle, 10000); });
  }
  helper.stdin.end();
  for (const key of policyKeys) {
    const removed = spawnSync("reg", ["delete", key, "/v", appName, "/f"], { encoding: "utf8" });
    if (removed.status !== 0) verdict("the test policy is removed", false, { key, stderr: removed.stderr });
  }
}

await writeFile(resolve(output, "result.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`FAIL ${failed.length} of ${results.length}: ${failed.map((result) => result.step).join("; ")}`);
  process.exit(1);
}
console.log(`PASS a minimized or tray-hidden window stops its page drawing (#594): ${results.length} checks`);
process.exit(0);
