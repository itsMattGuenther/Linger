// client/scripts/webview2-wait.mjs: the Windows checks wait for WebView2 by
// the clock (#813). They counted tries, and a refused try fails at once, so
// 60 tries a quarter of a second apart were 15 seconds: the audio check gave
// up 17 seconds after starting an app whose WebView2 was slower than that.
// These run on a pretend clock; the real reproduction, a Chromium whose
// debugging port opens after 20 seconds, is in #813's pull request.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { seconds, waitFor, whileRunning } from "./webview2-wait.mjs";

/** A pretend clock: sleeping moves it on, and so can a try. */
function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms) => { at += ms; },
    pass: (ms) => { at += ms; },
  };
}

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59624"), { code: "ECONNREFUSED" });

test("a WebView2 that answers after 20 seconds, refusing at once till then, is waited for", async () => {
  const time = clock();
  let tries = 0;
  const { got, took } = await waitFor("debugging didn't answer", async () => {
    tries += 1;
    if (time.now() < 20_000) throw refused();
    return "browser";
  }, time);
  assert.equal(got, "browser");
  assert.equal(took, 20_000);
  assert.ok(tries > 60, `${tries} tries: more than the 60 the old loop gave up after`);
});

test("it gives up by the clock, naming what and the last error", async () => {
  const time = clock();
  await assert.rejects(
    waitFor("Packaged WebView2's debugging port didn't answer", async () => { throw refused(); }, { ...time, within: 90_000 }),
    /^Error: Packaged WebView2's debugging port didn't answer within 90 s: connect ECONNREFUSED/,
  );
  assert.equal(time.now(), 90_000);
});

test("tries that take their whole timeout still stop by the clock", async () => {
  const time = clock();
  let tries = 0;
  await assert.rejects(waitFor("no answer", async () => {
    tries += 1;
    time.pass(1_000);
    throw new Error("timeout 1000ms exceeded");
  }, { ...time, within: 10_000 }), /no answer within 10 s: timeout 1000ms exceeded/);
  // A second a try and a quarter between: the ninth starts at the limit, so
  // it ends at most one try's timeout past it.
  assert.equal(tries, 9);
  assert.equal(time.now(), 11_000);
});

test("what waiting won't mend fails at once: the app exited", async () => {
  const time = clock();
  let exited = false;
  await assert.rejects(waitFor("no answer", async () => {
    exited = true;
    throw refused();
  }, { ...time, check: () => assert.equal(exited, false, "Packaged app exited: 1") }), /Packaged app exited: 1/);
  assert.equal(time.now(), 250, "one try, one pause, then the check");
});

test("nothing found yet is waited for like a refusal: a page that isn't there", async () => {
  const time = clock();
  const { got } = await waitFor("page missing", () => (time.now() >= 3_000 ? { url: "http://tauri.localhost/" } : undefined), time);
  assert.deepEqual(got, { url: "http://tauri.localhost/" });
  await assert.rejects(waitFor("page missing", () => undefined, { ...time, within: 1_000 }), /^Error: page missing within 1 s$/);
});

test("seconds reads as a person would", () => {
  assert.equal(seconds(20_412), "20.4 s");
  assert.equal(seconds(0), "0.0 s");
});

/** A stand-in for the spawned app: running until told otherwise. */
function fakeApp() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
}

test("an app that quits while its page is awaited fails as an exit, at once, not as a missing page (#814)", async () => {
  const time = clock();
  const app = fakeApp();
  const wait = whileRunning(app, "Packaged", time);
  const { took } = await wait("port didn't answer", () => "browser");
  assert.equal(took, 0);
  await assert.rejects(wait("Packaged application page missing from WebView2", () => {
    if (time.now() >= 2_000) app.exitCode = 1;
    return undefined;
  }), /^Error: Packaged app exited: 1$/);
  assert.ok(time.now() < 3_000, `noticed at ${time.now()} ms, not after 90 s`);
});

test("an app that failed to start, or was killed, fails the wait at once", async () => {
  const time = clock();
  const unstarted = fakeApp();
  const wait = whileRunning(unstarted, "Installed", time);
  unstarted.emit("error", new Error("spawn linger-client.exe ENOENT"));
  await assert.rejects(wait("no answer", () => undefined), /ENOENT/);

  const killed = fakeApp();
  killed.signalCode = "SIGKILL";
  await assert.rejects(whileRunning(killed, "Installed", time)("no answer", () => undefined), /^Error: Installed app exited: SIGKILL$/);
});

test("a running app's waits wait by the clock, as waitFor's do", async () => {
  const time = clock();
  const wait = whileRunning(fakeApp(), "Packaged", time);
  const { took } = await wait("port didn't answer", async () => {
    if (time.now() < 20_000) throw refused();
    return "browser";
  });
  assert.equal(took, 20_000);
});
