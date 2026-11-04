// scripts/maestro-driver.mjs (#857), on real runner logs: #856's run, where
// Maestro's driver died with Photos in front, and #838's, where a flow
// failed and the driver lived.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { said, verdict } from "./maestro-driver.mjs";

const SCRIPT = fileURLToPath(new URL("./maestro-driver.mjs", import.meta.url));
const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** #856's app.log, as far as this reads it: Linger's lines, and no share window's. */
const NO_SHARE = "2026-11-04 02:56:59.100 Df Linger[36786:18dc1] [com.apple.UIKit:Application] something\n";

test("a driver torn down mid-run is named, with the app in front, and re-run only with Linger ruled out", () => {
  const result = verdict(fixture("maestro-driver-died.log"), NO_SHARE);
  assert.deepEqual(result, { died: true, error: "Failed to get screenshot: Timed out while requesting screenshot.", front: ["com.apple.mobileslideshow"], shareWindow: false });
  const line = said(result);
  assert.match(line, /^::warning title=Maestro's driver died::/);
  assert.match(line, /The app in front: com\.apple\.mobileslideshow\. Linger wasn't in front, and its share window hadn't opened: re-run once \(#857\)\.$/);
});

// Greptile on #860: Linger's share window runs inside Photos' screen, so
// Photos in front doesn't clear Linger once the window has opened; and not
// knowing clears nothing.
test("Linger's share window open by then, inside Photos' screen, asks for a look, not a re-run", () => {
  const opened = `${NO_SHARE}2026-11-04 02:57:05.000 Df LingerShare[40962:1bc7a] [com.apple.UIKit:Application] started\n`;
  assert.match(said(verdict(fixture("maestro-driver-died.log"), opened)), /share window had opened, inside that app's screen: check it didn't freeze before re-running\.$/);
  // Opened only after the driver died: it can't be what froze.
  const later = `${NO_SHARE}2026-11-04 02:58:30.000 Df LingerShare[40962:1bc7a] [com.apple.UIKit:Application] started\n`;
  assert.equal(verdict(fixture("maestro-driver-died.log"), later).shareWindow, false);
});

test("not knowing the app in front, or the share window, asks for a look, never a re-run", () => {
  const noFront = verdict("<unknown>:0: error: -[x testHttpServer] : boom", NO_SHARE);
  assert.match(said(noFront), /The app in front: not known\. Which app, or whether Linger's share window was open, isn't known: check app\.log before re-running\.$/);
  const noAppLog = verdict(fixture("maestro-driver-died.log"));
  assert.equal(noAppLog.shareWindow, null);
  assert.match(said(noAppLog), /isn't known: check app\.log before re-running\.$/);
  assert.doesNotMatch(said(noFront) + said(noAppLog), /re-run once/);
});

test("a flow's own failure leaves the driver alive, and says so", () => {
  assert.deepEqual(verdict(fixture("maestro-flow-failed.log")), { died: false });
  assert.match(said({ died: false }), /alive to the end: the failure is a flow's own/);
});

test("with Linger in front, it asks for a look before a re-run, since a frozen app times out too", () => {
  const log = fixture("maestro-driver-died.log").replaceAll("com.apple.mobileslideshow", "io.github.itsmattguenther.linger");
  assert.match(said(verdict(log, NO_SHARE)), /The app in front: Linger\. Linger was in front: check it didn't freeze before re-running\.$/);
});

test("the front app is the last seen before the failure, and unknown if none was", () => {
  const log = ['Detected running apps: ["io.github.itsmattguenther.linger"]', 'Detected running apps: ["com.apple.mobileslideshow"]', "<unknown>:0: error: -[x testHttpServer] : boom", 'Detected running apps: ["io.github.itsmattguenther.linger"]'].join("\n");
  assert.deepEqual(verdict(log).front, ["com.apple.mobileslideshow"]);
  assert.equal(verdict("<unknown>:0: error: -[x testHttpServer] : boom").front, null);
});

test("run: reads every runner log in Maestro's output, and says nothing went wrong without one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "2026-11-04_025003"));
  writeFileSync(join(dir, "2026-11-04_025003", "xctest_runner_2026-11-04_025019.log"), fixture("maestro-driver-died.log"));
  writeFileSync(join(dir, "app.log"), NO_SHARE);
  const out = spawnSync(process.execPath, [SCRIPT, dir, join(dir, "app.log")], { encoding: "utf8" });
  assert.equal(out.status, 0, "never fails itself");
  assert.match(out.stdout, /::warning title=Maestro's driver died::.*re-run once/);
  const without = spawnSync(process.execPath, [SCRIPT, dir, join(dir, "no-app.log")], { encoding: "utf8" });
  assert.equal(without.status, 0);
  assert.match(without.stdout, /isn't known: check app\.log/);
  const none = spawnSync(process.execPath, [SCRIPT, join(dir, "nothing-here")], { encoding: "utf8" });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No XCUITest runner log/);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2, "says how to run it");
});
