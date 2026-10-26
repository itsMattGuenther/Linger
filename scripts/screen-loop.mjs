#!/usr/bin/env node
// Screen sharing end to end, against a real server (#360): a throwaway
// linger-server with voice on, two people in a room's voice through real
// gateway sessions, one browser page sharing a screen that changes colour
// and another watching it through the server. It passes when the colours
// the watcher draws follow the sharer's, at 30 and at 60 frames a second.
//
//   node scripts/screen-loop.mjs              # Chromium for both pages
//   LINGER_WEBKIT_WS=ws://… node scripts/screen-loop.mjs   # WebKit watches too
//
// It builds and starts the server from this checkout on 127.0.0.1, serves
// client/ with Vite, and cleans both up after.
//
// Against a test server of your own instead (never somebody's real one: it
// makes accounts and a room there), from its setup link's token, or with the
// host password from an earlier run:
//
//   LINGER_LOOP_SERVER=https://test.example LINGER_LOOP_SETUP=<token> node scripts/screen-loop.mjs
//
// LINGER_LOOP_WATCHERS=8 adds a load test after: a busy 1080p screen at
// 60 fps, watched by that many people at once for LINGER_LOOP_SECONDS (30),
// each reporting the frames and the bits a second that reached it.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT = join(ROOT, "client");
const require = createRequire(join(CLIENT, "package.json"));
const { chromium, webkit } = require("@playwright/test");

const HTTP = Number(process.env.LINGER_LOOP_PORT ?? 18_431);
const VOICE = HTTP + 1;
const PAGES = HTTP + 2;
const remote = process.env.LINGER_LOOP_SERVER?.replace(/\/+$/, "");
const base = remote ?? `http://127.0.0.1:${HTTP}`;
const PASSWORD = process.env.LINGER_LOOP_PASSWORD ?? "correct horse battery";
const WATCHERS = Number(process.env.LINGER_LOOP_WATCHERS ?? 0);
const SECONDS = Number(process.env.LINGER_LOOP_SECONDS ?? 30);
// Names of their own each run, so a test server can be used again.
const run = remote ? String(Date.now() % 100_000) : "";
const children = [];
const data = mkdtempSync(join(tmpdir(), "linger-screen-loop-"));

function cleanUp() {
  for (const child of children) child.kill("SIGTERM");
  rmSync(data, { recursive: true, force: true });
}
process.on("exit", cleanUp);
process.on("SIGINT", () => process.exit(130));

function start(command, args, options) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

/** Wait for a line matching `pattern` on a child's output. */
function waitFor(child, pattern, what, ms = 600_000) {
  return new Promise((done, fail) => {
    let seen = "";
    const timer = setTimeout(() => fail(new Error(`${what}: nothing after ${ms / 1000}s\n${seen.slice(-2000)}`)), ms);
    const read = (chunk) => {
      seen += chunk.toString();
      const found = pattern.exec(seen);
      if (found) {
        clearTimeout(timer);
        done(found);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => fail(new Error(`${what}: exited ${code}\n${seen.slice(-2000)}`)));
  });
}

async function json(method, path, body, token) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** A gateway session in a room's voice: its id, and the socket to keep open. */
async function inVoice(token, room) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/api/v1/gateway`);
  const session = await new Promise((done, fail) => {
    socket.addEventListener("error", () => fail(new Error("gateway socket failed")));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      if (frame.op === "hello") socket.send(JSON.stringify({ op: "identify", d: { token, client: "screen-loop/0" } }));
      if (frame.op === "ready") done(frame.d.session_id);
    });
  });
  socket.send(JSON.stringify({ op: "voice.join", d: { room_id: room, forwarding: true } }));
  await new Promise((done) => setTimeout(done, 500));
  return { session, socket };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Whether the watcher's colour is near `want`, read a few times over `ms`. */
async function shows(page, want, ms) {
  const until = Date.now() + ms;
  let last = [];
  while (Date.now() < until) {
    last = await page.evaluate(() => window.loop.pixel());
    if (last.length === 4 && want.every((value, at) => Math.abs(value - last[at]) < 40)) return true;
    await sleep(100);
  }
  console.log(`  the watcher showed ${JSON.stringify(last)}, wanted ${JSON.stringify(want)}`);
  return false;
}

/** The host's sign-in: from the setup link on a new server, else the password. */
async function signInHost() {
  let setup = process.env.LINGER_LOOP_SETUP;
  if (!remote) {
    console.log("Building and starting the server…");
    const server = start("cargo", ["run", "-q", "-p", "linger-server"], {
      cwd: ROOT,
      env: {
        ...process.env,
        LINGER_DATA_DIR: data,
        LINGER_BIND: `127.0.0.1:${HTTP}`,
        LINGER_VOICE_ADDRESS: "127.0.0.1",
        LINGER_VOICE_BIND: `127.0.0.1:${VOICE}`,
        RUST_LOG: "warn",
      },
    });
    [, setup] = await waitFor(server, /setup\?token=([A-Za-z0-9_-]+)/, "the server's setup link");
  }
  if (setup) {
    try {
      return await json("POST", "/setup", { token: setup, server_name: "loop", username: "host", display_name: "Host", password: PASSWORD });
    } catch (error) {
      if (!remote) throw error;
      console.log("The server is set up already; signing in as host.");
    }
  }
  return json("POST", "/auth/login", { username: "host", password: PASSWORD });
}

/** A person in the room's voice, signed up with `invite`. */
async function person(invite, name, room) {
  const account = await json("POST", "/auth/register", { invite_code: invite.code, username: `${name}${run}`, display_name: `${name}${run}`, password: "a perfectly fine password" });
  return { token: account.access_token, ...(await inVoice(account.access_token, room)) };
}

/**
 * A watcher with no page: a screen socket that counts what reaches it. The
 * server can't tell it from the app, so it costs the server what a person
 * watching costs, without a browser decoding 1080p for every one.
 */
function countingWatcher(token, session, target) {
  const counts = { frames: 0, keys: 0, bytes: 0, closed: null };
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/screen`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => socket.send(JSON.stringify({ op: "watch", token, session_id: session, target, decode: ["vp8", "avc1"] })));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    counts.frames += 1;
    counts.bytes += event.data.byteLength;
    // The header's flags byte (PROTOCOL §8): bit 0 is a key frame.
    if (new Uint8Array(event.data)[2] & 1) counts.keys += 1;
  });
  socket.addEventListener("close", (event) => {
    counts.closed = event.code;
  });
  return { counts, close: () => socket.close() };
}

async function loadTest(sharing, host, sharer, watchers) {
  console.log(`Load: a busy 1080p screen at 60 fps, ${watchers.length} watching for ${SECONDS}s…`);
  await sharing.evaluate(() => window.loop.busy(true));
  await sharing.evaluate(({ base, token, session }) => window.loop.share(base, token, session, 60), { base, token: host.access_token, session: sharer.session });
  await sleep(2_000);
  const lines = watchers.map((watcher) => countingWatcher(watcher.token, watcher.session, sharer.session));
  await sleep(3_000);
  const before = lines.map((line) => ({ ...line.counts }));
  await sleep(SECONDS * 1_000);
  const rows = lines.map((line, at) => ({
    fps: (line.counts.frames - before[at].frames) / SECONDS,
    mbit: ((line.counts.bytes - before[at].bytes) * 8) / SECONDS / 1_000_000,
    keys: line.counts.keys - before[at].keys,
    closed: line.counts.closed,
  }));
  const shared = await sharing.evaluate(() => window.loop.share_state()?.status ?? "stopped");
  for (const line of lines) line.close();
  await sharing.evaluate(() => window.loop.stop());
  await sharing.evaluate(() => window.loop.busy(false));
  rows.forEach((row, at) => console.log(`  watcher ${at + 1}: ${row.fps.toFixed(1)} fps, ${row.mbit.toFixed(2)} Mbit/s, ${row.keys} key frames${row.closed ? `, closed ${row.closed}` : ""}`));
  const fastest = Math.max(...rows.map((row) => row.fps));
  console.log(`  the fastest watcher got ${fastest.toFixed(1)} fps; the share is ${shared}`);
  // What the sharer makes depends on this computer's encoder, so each
  // watcher is held to the best one rather than to 60: the server's part is
  // that adding watchers costs none of them frames.
  return shared === "sharing" && fastest >= 20 && rows.every((row) => !row.closed && row.fps >= fastest * 0.9);
}

async function main() {
  const host = await signInHost();
  const invite = await json("POST", "/invites", { max_uses: WATCHERS + 1 }, host.access_token);
  const room = await json("POST", "/rooms", { slug: `loop${run}`, name: `#loop${run}` }, host.access_token);
  const sharer = await inVoice(host.access_token, room.id);
  const watcher = await person(invite, "eli", room.id);

  console.log("Serving the pages…");
  const vite = start("pnpm", ["exec", "vite", "--port", String(PAGES), "--strictPort", "--host", "127.0.0.1"], { cwd: CLIENT });
  await waitFor(vite, /Local:/, "vite", 60_000);

  const engines = [["chromium", await chromium.launch()]];
  if (process.env.LINGER_WEBKIT_WS) engines.push(["webkit", await webkit.connect(process.env.LINGER_WEBKIT_WS)]);
  const page = `http://127.0.0.1:${PAGES}/tests/fixtures/screen-loop.html`;
  const sharing = await engines[0][1].newPage();
  await sharing.goto(page);
  let failed = false;

  for (const fps of [30, 60]) {
    await sharing.evaluate(({ base, token, session, fps }) => window.loop.share(base, token, session, fps), { base, token: host.access_token, session: sharer.session, fps });
    for (const [engine, browser] of engines) {
      const watching = await browser.newPage();
      await watching.goto(page);
      await watching.evaluate(({ base, token, session, target }) => window.loop.watch(base, token, session, target), {
        base,
        token: watcher.token,
        session: watcher.session,
        target: sharer.session,
      });
      await sharing.evaluate(() => window.loop.paint("#ff0000"));
      const red = await shows(watching, [255, 0, 0, 255], 10_000);
      await sharing.evaluate(() => window.loop.paint("#0000ff"));
      const blue = await shows(watching, [0, 0, 255, 255], 5_000);
      const state = await watching.evaluate(() => window.loop.watch_state());
      console.log(`${fps} fps, ${engine} watching: red ${red ? "arrived" : "DIDN'T"}, blue ${blue ? "arrived" : "DIDN'T"} (${JSON.stringify(state)})`);
      failed ||= !red || !blue;
      await watching.evaluate(() => window.loop.stop());
      await watching.close();
    }
    await sharing.evaluate(() => window.loop.stop());
    await sleep(300);
  }
  if (WATCHERS > 0) {
    const crowd = [watcher];
    for (let at = 1; at < WATCHERS; at += 1) crowd.push(await person(invite, `w${at}_`, room.id));
    const kept = await loadTest(sharing, host, sharer, crowd);
    console.log(kept ? "  every watcher kept up" : "  NOT every watcher kept up");
    failed ||= !kept;
    for (const one of crowd.slice(1)) one.socket.close();
  }
  for (const [, browser] of engines) await browser.close();
  sharer.socket.close();
  watcher.socket.close();
  console.log(failed ? "FAILED" : "Passed: the screen arrived through the server at both speeds.");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
