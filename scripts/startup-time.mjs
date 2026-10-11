#!/usr/bin/env node
// How long Linger takes to open, signed in, measured from outside (T-910).
// docs/performance.md has what it found, and what a change may cost.
//
// "Opens" means: from the app's process starting (what a click on its icon
// does, after the launcher's own part) to the list window on screen showing
// your servers, their rooms and the people in them. Nothing inside the app is
// changed or asked: the screen is watched instead. The window opens on a
// screen of its own that nobody can see (a headless Hyprland output, far from
// the real ones), and that screen is photographed as fast as `grim` allows,
// every 30–60 ms. The list counts as open at the first photograph from which
// the window looks the way it finally settles, and stays that way. Left out
// of that comparison: anything that never stops moving (a shimmering name),
// and the right edge, where the scrollbar shows for a moment and fades.
//
// It needs Linux, Hyprland, `grim`, `dd`, `fincore`, `readelf`, `dbus-daemon`,
// `gnome-keyring-daemon` and `secret-tool`. Build the app as the release
// workflow does, plus one change: its CSP also lets it reach
// http://127.0.0.1, because the throwaway servers have no certificate. An
// installed Linger only talks https, and the CSP is the only thing that stops
// it here. Nothing else differs.
//
//   cd client && csp=$(node -e 'const c=require("./src-tauri/tauri.conf.json").app.security.csp; process.stdout.write(c.replace("connect-src ", "connect-src http://127.0.0.1:* ws://127.0.0.1:* ").replace(/(img|media)-src /g, "$1-src http://127.0.0.1:* "))')
//   pnpm tauri build --no-bundle --config "$(node -e 'process.stdout.write(JSON.stringify({bundle:{createUpdaterArtifacts:false},app:{security:{csp:process.argv[1]}}}))' "$csp")"
//   cd .. && cargo build -p linger-server --release
//   node scripts/startup-time.mjs --app client/src-tauri/target/release/linger-client \
//     --server target/release/linger-server --label main --out ~/linger-startup/today
//
// Give --app, --server and --label again for a second build (another
// worktree's) and the two take turns, launch by launch, so whatever else the
// machine is doing weighs on both alike. Two builds measured at different
// times mostly compare what the machine was doing.
//
// For each build it starts two throwaway servers on 127.0.0.1 (on free ports
// from --port up, a proxy in front of each) and fills them like a friend group's:
// 22 and 11 people, rooms with history, DMs, statuses, ten of the people
// online. It signs one person in to both with a keyring of its own (a private
// D-Bus that starts nothing on demand, and a gnome-keyring), so your own
// Linger, keyring and sign-ins are never touched. Then it opens Linger again
// and again, --runs times each way:
//
// - "boot": as after a restart with no other WebKitGTK app open. Linger's own
//   files are pushed out of memory first, and it starts with uncached copies
//   of the libraries only it uses (WebKitGTK and friends).
// - "cold": Linger's own files pushed out of memory, but the libraries stay,
//   as when another WebKitGTK app (an installed Linger, say) is running.
//   Without root nothing can push out a file another program has loaded.
// - "warm": straight after, the way a second open is.
//
// After each run it adds up the memory of Linger and its WebKit processes,
// and at the end it leaves one open for --idle seconds and measures how much
// processor time each of them takes while nothing happens. --rtt puts that
// many milliseconds between the app and both servers, like a server across
// the internet; --film keeps every photograph that changed, to look at.
//
// This sends nothing anywhere but the two local servers. The app does what
// it always does when it starts, which includes asking GitHub whether there
// is a newer version. Nothing in the app records anything (Hard Rule 4).
// Everything this makes is in --out; the servers, the keyring and the screen
// are stopped and removed when it ends.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// The arithmetic, kept apart so it can be tested (startup-time.test.mjs).
// ---------------------------------------------------------------------------

/** Median and worst of some timings, in whole milliseconds. */
export function summary(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, median: null, worst: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, median: Math.round(median), worst: Math.round(sorted[sorted.length - 1]) };
}

/** A binary PPM (P6), as `grim -t ppm` writes it, as RGB bytes. */
export function parsePpm(buffer) {
  let at = 0;
  const token = () => {
    for (;;) {
      while (at < buffer.length && /\s/.test(String.fromCharCode(buffer[at]))) at++;
      if (buffer[at] !== 0x23) break; // a comment, to the end of the line
      while (at < buffer.length && buffer[at] !== 0x0a) at++;
    }
    const start = at;
    while (at < buffer.length && !/\s/.test(String.fromCharCode(buffer[at]))) at++;
    return buffer.toString("latin1", start, at);
  };
  if (token() !== "P6") throw new Error("not a binary PPM");
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (!(width > 0 && height > 0 && max === 255)) throw new Error("unsupported PPM");
  at++; // the one whitespace byte before the pixels
  const data = buffer.subarray(at, at + width * height * 3);
  if (data.length !== width * height * 3) throw new Error("short PPM");
  return { width, height, data };
}

/**
 * Every `step`th pixel each way, which is plenty to tell a list of names from
 * an empty window and keeps a few hundred photographs in a few hundred MB.
 */
export function shrink(image, step = 2) {
  const width = Math.ceil(image.width / step);
  const height = Math.ceil(image.height / step);
  const data = new Uint8Array(width * height * 3);
  let out = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const from = (y * image.width + x) * 3;
      data[out++] = image.data[from];
      data[out++] = image.data[from + 1];
      data[out++] = image.data[from + 2];
    }
  }
  return { width, height, data };
}

const differs = (a, b, i, tolerance) =>
  Math.abs(a[i] - b[i]) > tolerance || Math.abs(a[i + 1] - b[i + 1]) > tolerance || Math.abs(a[i + 2] - b[i + 2]) > tolerance;

/**
 * When a sequence of photographs of one window reached the way it ends up.
 *
 * `frames` are `{ at, image }`, oldest first, `at` in ms. The last one is how
 * the window ends up. Two things are left out of the comparison: pixels that
 * still change during the last `tailMs` (an animation that never stops, a
 * shimmering name), and the rightmost `edge` of the window, where the
 * scrollbar shows for a moment when the list grows and then fades. A
 * photograph matches when no more than `allowed` of the remaining pixels
 * differ from the last one by more than `tolerance` in any colour. The answer
 * is the first photograph from which every later one matches too, so a moment
 * that only looked finished doesn't count; `null` when the window never held
 * still long enough to say. `blank` is the first photograph with anything
 * drawn inside the window's edges: the first thing a person could read.
 */
export function settled(frames, { tailMs = 1500, tolerance = 24, allowed = 0.002, edge = 0.04 } = {}) {
  if (frames.length === 0) return { done: null, blank: null, moving: 0 };
  const last = frames[frames.length - 1];
  const { width, height, data: end } = last.image;
  const pixels = width * height;
  const ignored = new Uint8Array(pixels);
  const firstIgnoredColumn = width - Math.ceil(width * edge);
  for (let p = 0; p < pixels; p++) if (p % width >= firstIgnoredColumn) ignored[p] = 1;
  let movingCount = 0;
  for (let f = frames.length - 2; f >= 0 && last.at - frames[f].at <= tailMs; f--) {
    const image = frames[f].image;
    if (image.width !== width || image.height !== height) continue;
    for (let p = 0, i = 0; p < pixels; p++, i += 3) {
      if (!ignored[p] && differs(image.data, end, i, tolerance)) {
        ignored[p] = 1;
        movingCount++;
      }
    }
  }
  let compared = 0;
  for (let p = 0; p < pixels; p++) compared += 1 - ignored[p];
  const limit = Math.floor(compared * allowed);
  const matches = (image) => {
    if (image.width !== width || image.height !== height) return false;
    let off = 0;
    for (let p = 0, i = 0; p < pixels; p++, i += 3) {
      if (!ignored[p] && differs(image.data, end, i, tolerance) && ++off > limit) return false;
    }
    return true;
  };
  let done = frames.length - 1;
  while (done > 0 && matches(frames[done - 1].image)) done--;
  // A window that only matched for its very last stretch hadn't settled yet.
  const held = last.at - frames[done].at;
  const blank = frames.findIndex((frame) => !flat(frame.image, tolerance));
  return { done: held >= tailMs ? done : null, blank: blank === -1 ? null : blank, moving: movingCount / pixels };
}

/**
 * Whether the inside of a window is one colour: nothing drawn yet. The
 * outermost `margin` is left out, where a window's rounded corners show
 * whatever is behind it.
 */
export function flat(image, tolerance, margin = 0.05) {
  const { width, height, data } = image;
  const mx = Math.floor(width * margin);
  const my = Math.floor(height * margin);
  const first = (my * width + mx) * 3;
  for (let y = my; y < height - my; y++) {
    for (let x = mx; x < width - mx; x++) {
      const i = (y * width + x) * 3;
      if (Math.abs(data[i] - data[first]) > tolerance || Math.abs(data[i + 1] - data[first + 1]) > tolerance || Math.abs(data[i + 2] - data[first + 2]) > tolerance) return false;
    }
  }
  return true;
}

/** utime + stime, in clock ticks, from a /proc/<pid>/stat line. */
export function cpuTicks(stat) {
  // The name is in parentheses and may hold spaces or parentheses itself.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

/** When a process started, in clock ticks since boot, from a /proc/<pid>/stat line. */
export function startTicks(stat) {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

/** The parent pid from a /proc/<pid>/stat line. */
export function parentPid(stat) {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

/** Resident, proportional and private memory in kB, from /proc/<pid>/smaps_rollup. */
export function memory(rollup) {
  const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(rollup)?.[1] ?? 0);
  return { rss: kb("Rss"), pss: kb("Pss"), uss: kb("Private_Clean") + kb("Private_Dirty") };
}

/** A small deterministic random source, so every run seeds the same friend group. */
export function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: (list) => list[Math.floor(next() * list.length)], int: (low, high) => low + Math.floor(next() * (high - low + 1)) };
}

const PALETTE = ["ember", "rust", "amber", "brass", "lime", "fern", "mint", "teal", "cyan", "sky", "azure", "indigo", "violet", "orchid", "rose"];
const FONTS = ["geist-sans", "ibm-plex-sans", "inter", "space-grotesk", "newsreader", "instrument-serif", "departure-mono", "silkscreen", "jetbrains-mono", "commit-mono"];
const NAMES = ["juniper", "wren", "otis", "marlow", "hazel", "dex", "ines", "bodhi", "pia", "rowan", "sully", "tamsin", "callum", "noor",
  "fitz", "odette", "kai", "lark", "mabel", "remy", "sage", "theo", "vera", "yusuf", "zadie", "arlo", "bea", "cass", "dmitri", "elsie", "finch", "gus"];
const LINES = ["anyone up for a run tonight?", "ok that boss fight was rough", "brb, dinner", "did you see the patch notes",
  "I'm making soup again, nobody stop me", "that's the best thing I've heard all week", "lol", "honestly same",
  "the new album is so good, front to back", "I'll be on around 9", "can't tonight, early shift tomorrow", "who has the spreadsheet",
  "photos from saturday coming up later", "this is why we can't have nice things", "ok but hear me out", "nope", "yes!!",
  "it worked on my machine 🙃", "pizza or tacos, final answer", "I fell asleep at 8 like a grandpa", "the cat knocked the router over again",
  "we should do the lake thing again before it gets cold", "that's a good point actually", "wait what happened", "🎉🎉🎉",
  "anyone else's internet terrible tonight", "reading that book you lent me, finally", "I think I left my charger at yours",
  "gg everyone", "new high score, not that anybody asked", "the dog learned to open the fridge. we are doomed",
  "I made a playlist for the drive, it's 40% sea shanties", "the raid is at 8 server time, bring flasks", "happy birthday!! 🎂"];
const STATUS_LINES = ["out walking the dog", "raid at 8", "head down, deadline friday", "on the porch", "making bread", "back sunday",
  "playing the new zelda", "listening to the radio", "napping, wake me for pizza", "studying"];

/** One message body: one to three lines of small talk, now and then a longer paragraph. */
function body(rng) {
  const parts = [];
  const count = rng.next() < 0.15 ? rng.int(3, 6) : rng.int(1, 2);
  for (let i = 0; i < count; i++) parts.push(rng.pick(LINES));
  return rng.next() < 0.2 ? parts.join("\n") : parts.join(" ");
}

/** A name style the way people pick them: a font, a colour, sometimes a gradient or a glow. */
function style(rng, effect = "none") {
  const fill = rng.next() < 0.2
    ? { kind: "gradient", from: rng.pick(PALETTE), to: rng.pick(PALETTE) }
    : { kind: "solid", color: rng.pick(PALETTE) };
  return { font_key: rng.pick(FONTS), weight: rng.pick([400, 500, 700]), italic: rng.next() < 0.15, fill, effect, msg_font_key: null };
}

/**
 * What a server holds: its people, rooms, conversations and statuses. The
 * first person is the host and `me` is who Linger signs in as.
 */
export function plan({ seed, name, people, rooms, messages, dms, online, me = "wren", shimmer: anyShimmer = true }) {
  const rng = random(seed);
  const names = [NAMES[0], me, ...NAMES.filter((one) => one !== NAMES[0] && one !== me)].slice(0, people);
  const roomList = rooms.map((slug, index) => ({ slug, name: `#${slug}`, topic: index % 3 === 0 ? rng.pick(LINES) : null }));
  const posts = [];
  for (let i = 0; i < messages; i++) {
    // Busier rooms first, as in any group: the first room gets about a third.
    const room = rng.next() < 0.35 ? 0 : rng.int(0, roomList.length - 1);
    posts.push({ room, author: rng.int(0, names.length - 1), body: body(rng) });
  }
  const dmList = dms.map((size) => {
    const others = [];
    while (others.length < size - 1) {
      const person = rng.int(2, names.length - 1);
      if (!others.includes(person)) others.push(person);
    }
    const members = [1, ...others];
    return { members, posts: Array.from({ length: rng.int(25, 60) }, () => ({ author: rng.pick(members), body: body(rng) })) };
  });
  const shimmer = 2 + rng.int(0, Math.max(0, online - 1));
  const looks = names.map((_, index) => ({
    style: style(rng, index === shimmer && anyShimmer ? "shimmer" : rng.next() < 0.1 ? "glow" : "none"),
    status: rng.next() < 0.45 ? { line: rng.pick(STATUS_LINES) } : null,
  }));
  // Who is online besides you: the first `online` people after you.
  const around = names.map((_, index) => index >= 2 && index < 2 + online);
  return { name, names, rooms: roomList, posts, dms: dmList, looks, around, me: 1 };
}

// ---------------------------------------------------------------------------
// Everything below drives real processes, so it only runs as a command.
// ---------------------------------------------------------------------------

const BENCH = "LINGERBENCH";
const WORKSPACE = "lingerbench";
const now = () => performance.timeOrigin + performance.now();
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function api(base, path, { token, method = "POST", json } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (response.status === 429 && attempt < 20) {
      const wait = JSON.parse(text || "{}").retry_after_ms ?? 1000;
      await sleep(wait + 50);
      continue;
    }
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}

/** A linger-server on `port` with its own data, and its one-time setup token. */
async function startServer(binary, port, dir) {
  mkdirSync(dir, { recursive: true });
  const out = createWriteStream(join(dir, "server.log"));
  const child = spawn(binary, [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LINGER_BIND: `127.0.0.1:${port}`, LINGER_DATA_DIR: dir, RUST_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let seen = "";
  const token = await new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`server on ${port} printed no setup token`)), 30_000);
    child.stdout.on("data", (chunk) => {
      out.write(chunk);
      seen += chunk;
      const match = /setup\?token=([A-Za-z0-9_-]+)/.exec(seen);
      if (match) {
        clearTimeout(timer);
        settle(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => out.write(chunk));
    child.once("exit", (code) => fail(new Error(`server on ${port} exited (${code}); see ${dir}/server.log`)));
  });
  // The setup link is printed before the server takes the port.
  for (let tries = 0; ; tries++) {
    const listening = await new Promise((settle) => {
      const probe = connect(port, "127.0.0.1", () => {
        probe.destroy();
        settle(true);
      });
      probe.once("error", () => settle(false));
    });
    if (listening) break;
    if (tries > 300) throw new Error(`server on ${port} never took its port; see ${dir}/server.log`);
    await sleep(100);
  }
  return { child, token, base: `http://127.0.0.1:${port}` };
}

/** Fill a fresh server from a plan. Returns everybody's tokens. */
async function seed(server, layout) {
  const { base } = server;
  const password = "startup-time-bench";
  const host = await api(base, "/setup", {
    json: { token: server.token, server_name: layout.name, username: layout.names[0], display_name: layout.names[0], password },
  });
  const accounts = [host];
  const invite = await api(base, "/invites", { token: host.access_token, json: { max_uses: null } });
  for (const name of layout.names.slice(1)) {
    accounts.push(await api(base, "/auth/register", { json: { invite_code: invite.code, username: name, display_name: name, password } }));
  }
  const rooms = [];
  for (const room of layout.rooms) rooms.push(await api(base, "/rooms", { token: host.access_token, json: room }));
  await Promise.all(layout.looks.map((look, index) =>
    api(base, "/me", {
      method: "PATCH",
      token: accounts[index].access_token,
      json: {
        style: look.style,
        ...(look.status ? { status: { line: look.status.line, reading: null, listening: null, working_on: null, fields: null, image_id: null, image_url: null, away_message: null, away_since: null } } : {}),
      },
    })));
  // Each person posts in turn, at the pace the server allows one person.
  const queues = layout.names.map(() => []);
  layout.posts.forEach((post) => queues[post.author].push({ room: rooms[post.room].id, body: post.body }));
  for (const dm of layout.dms) {
    const others = dm.members.filter((member) => member !== dm.members[0]).map((member) => accounts[member].user.id);
    const room = await api(base, "/dms", { token: accounts[dm.members[0]].access_token, json: { user_ids: others } });
    dm.posts.forEach((post) => queues[post.author].push({ room: room.id, body: post.body }));
  }
  await Promise.all(queues.map(async (queue, index) => {
    for (const post of queue) await api(base, `/rooms/${post.room}/messages`, { token: accounts[index].access_token, json: { body: post.body } });
  }));
  return accounts;
}

/**
 * Stand between the app and a server, pass everything through, and say when
 * each request and gateway connection arrived, one JSON line each. It runs
 * as a process of its own (`--proxy`), so photographing the screen never
 * holds up the app's requests. With `rttMs`, every request and every
 * gateway frame waits half of it each way, like a server across the internet.
 */
function proxy(listen, target, rttMs) {
  const half = rttMs / 2;
  const later = (step) => (half > 0 ? setTimeout(step, half) : step());
  const report = (event) => process.stdout.write(`${JSON.stringify({ at: now(), ...event })}\n`);
  const server = createServer((request, response) => {
    report({ kind: "request", method: request.method, path: request.url });
    const body = [];
    request.on("data", (chunk) => body.push(chunk));
    request.on("end", () => later(() => {
      const upstream = httpRequest({ host: "127.0.0.1", port: target, method: request.method, path: request.url, headers: request.headers }, (answer) => {
        const reply = [];
        answer.on("data", (chunk) => reply.push(chunk));
        answer.on("end", () => later(() => {
          const headers = { ...answer.headers };
          delete headers["transfer-encoding"];
          response.writeHead(answer.statusCode, headers);
          response.end(Buffer.concat(reply));
        }));
      });
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      upstream.end(Buffer.concat(body));
    }));
  });
  server.on("upgrade", (request, socket, head) => {
    report({ kind: "upgrade", path: request.url });
    const upstream = connect(target, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      // Timers with the same delay run in order, so frames stay in order.
      upstream.on("data", (chunk) => later(() => socket.write(chunk)));
      socket.on("data", (chunk) => later(() => upstream.write(chunk)));
    });
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", end);
    upstream.on("close", end);
    socket.on("error", end);
    socket.on("close", end);
  });
  server.listen(listen, "127.0.0.1", () => report({ kind: "listening" }));
}

/** Start a proxy process and keep what it reports. */
function startProxy(listen, target, rttMs) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--proxy", String(listen), String(target), String(rttMs)], { stdio: ["ignore", "pipe", "inherit"] });
  const events = [];
  let rest = "";
  let ready;
  const listening = new Promise((settle, fail) => {
    ready = settle;
    child.once("exit", (code) => fail(new Error(`the proxy on port ${listen} stopped (${code}); is the port taken?`)));
  });
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.kind === "listening") ready();
      else events.push(event);
    }
  });
  return { child, events, listening, base: `http://127.0.0.1:${listen}` };
}

/** Keep somebody connected to the gateway, as their own app would. */
function online(base, account) {
  let socket;
  let heartbeat;
  let stopped = false;
  let token = account.access_token;
  let refresh = account.refresh_token;
  const open = () => {
    socket = new WebSocket(`${base.replace("http", "ws")}/api/v1/gateway`);
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.op === "hello") {
        socket.send(JSON.stringify({ op: "identify", d: { token, client: "startup-time/1" } }));
        heartbeat = setInterval(() => socket.send(JSON.stringify({ op: "heartbeat", d: { s: 0 } })), frame.d.heartbeat_interval_ms * 0.8);
      }
    });
    socket.addEventListener("close", async () => {
      clearInterval(heartbeat);
      if (stopped) return;
      try {
        const fresh = await api(base, "/auth/refresh", { json: { refresh_token: refresh } });
        token = fresh.access_token;
        refresh = fresh.refresh_token;
      } catch {
        // The next close tries again.
      }
      setTimeout(open, 1000);
    });
  };
  open();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    socket?.close();
  };
}

/** A private D-Bus and an unlocked gnome-keyring holding the sign-ins, as Linger's keyring code stores them. */
function keyring(runtime, profile, sessions, cleanups) {
  mkdirSync(join(runtime, "keyring"), { recursive: true, mode: 0o700 });
  // A bus that starts nothing on demand. The desktop's own services must never
  // be started on it: a second accessibility bus launcher takes over the real
  // one's socket path in the runtime directory, and every GTK app started
  // after that can't reach accessibility (WebKitGTK then crashes in
  // atk-bridge). The app is pointed at the desktop's real accessibility bus
  // instead (AT_SPI_BUS_ADDRESS, below).
  const config = join(runtime, "bus.conf");
  writeFileSync(config, [
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    "<busconfig>",
    "  <type>session</type>",
    `  <listen>unix:path=${join(runtime, "bus")}</listen>`,
    "  <auth>EXTERNAL</auth>",
    '  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>',
    "</busconfig>",
    "",
  ].join("\n"));
  const [address, pid] = execFileSync("dbus-daemon", [`--config-file=${config}`, "--fork", "--print-address=1", "--print-pid=1"], { encoding: "utf8" }).trim().split("\n");
  cleanups.push(() => stop([Number(pid)]));
  const env = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: address,
    XDG_DATA_HOME: join(profile, "data"),
    XDG_CONFIG_HOME: join(profile, "config"),
    GNOME_KEYRING_CONTROL: join(runtime, "keyring"),
  };
  execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets", `--control-directory=${join(runtime, "keyring")}`], { env, input: "bench" });
  execFileSync("gnome-keyring-daemon", ["--start", "--components=secrets", `--control-directory=${join(runtime, "keyring")}`], { env });
  const daemon = execFileSync("pgrep", ["-f", "--", `--control-directory=${join(runtime, "keyring")}`], { encoding: "utf8" }).trim().split("\n").map(Number);
  cleanups.push(() => stop(daemon));
  const store = (account, value) =>
    execFileSync("secret-tool", ["store", `--label=Linger ${account}`, "service", "com.linger.desktop", "username", account, "target", "default", "application", "rust-keyring"], { env, input: value });
  for (const session of sessions) store(`session-server:${session.base_url}`, JSON.stringify(session));
  store("session-servers", JSON.stringify(sessions.map((session) => session.base_url)));
  return { address, daemon };
}

const hyprctl = (...args) => execFileSync("hyprctl", args, { encoding: "utf8" });
const lua = (code) => {
  const out = hyprctl("eval", code).trim();
  if (out !== "ok") throw new Error(`hyprctl eval: ${out}`);
};

/** A screen of its own, far from every real one so the pointer can't wander onto it. */
/**
 * The screen's refresh rate: 240 while photographing, so a frame is never
 * long in coming, and an ordinary 60 while measuring idle use, since an app
 * that animates draws once per refresh.
 */
function screenRate(rate) {
  lua(`hl.monitor({output="${BENCH}", mode="1280x1120@${rate}", position="-30000x-30000", scale=1.25})`);
}

function benchScreen() {
  screenRate(240);
  lua(`hl.workspace_rule({workspace="name:${WORKSPACE}", monitor="${BENCH}", default=true})`);
  if (!hyprctl("monitors", "-j").includes(`"${BENCH}"`)) hyprctl("output", "create", "headless", BENCH);
  return () => hyprctl("output", "remove", BENCH);
}

/** Hyprland's event stream, for the moment a window appears. */
function windowEvents() {
  const path = join(process.env.XDG_RUNTIME_DIR, "hypr", process.env.HYPRLAND_INSTANCE_SIGNATURE, ".socket2.sock");
  const socket = connect(path);
  const waiting = [];
  let rest = "";
  socket.on("data", (chunk) => {
    const at = now();
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const match = /^openwindow>>([0-9a-f]+),([^,]*),([^,]*),/.exec(line);
      if (!match || match[2] !== WORKSPACE) continue;
      waiting.shift()?.({ address: `0x${match[1]}`, className: match[3], at });
    }
  });
  return {
    next: (ms) => new Promise((settle, fail) => {
      const timer = setTimeout(() => fail(new Error("no window appeared")), ms);
      waiting.push((event) => {
        clearTimeout(timer);
        settle(event);
      });
    }),
    close: () => socket.destroy(),
  };
}

function grab(region) {
  return new Promise((settle) => {
    const started = now();
    const child = spawn("grim", ["-g", region, "-t", "ppm", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code) => settle(code === 0 ? { started, at: now(), buffer: Buffer.concat(chunks) } : null));
  });
}

/** Every process the app started, itself included. */
function tree(root) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parent = parentPid(readFileSync(`/proc/${entry}/stat`, "utf8"));
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(entry));
    } catch {
      // Gone already.
    }
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all.filter((pid) => existsSync(`/proc/${pid}`));
}

function treeMemory(pids) {
  const total = { rss: 0, pss: 0, uss: 0, processes: [] };
  for (const pid of pids) {
    try {
      const one = memory(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      total.processes.push({ name, ...one });
      total.rss += one.rss;
      total.pss += one.pss;
      total.uss += one.uss;
    } catch {
      // Gone already.
    }
  }
  return total;
}

/** Processor time so far, in clock ticks, per process, by pid. */
function treeTicks(pids) {
  const ticks = new Map();
  for (const pid of pids) {
    try {
      ticks.set(pid, { name: readFileSync(`/proc/${pid}/comm`, "utf8").trim(), ticks: cpuTicks(readFileSync(`/proc/${pid}/stat`, "utf8")) });
    } catch {
      // Gone already.
    }
  }
  return ticks;
}

/** The files a running app has open or mapped, to push out of memory before a cold run. */
function filesOf(pids) {
  const files = new Set();
  for (const pid of pids) {
    try {
      for (const line of readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
        const path = line.split(/\s+/).slice(5).join(" ");
        if (path.startsWith("/") && !path.startsWith("/dev/") && !path.startsWith("/memfd:") && !path.includes(" (deleted)")) files.add(path);
      }
    } catch {
      // Gone already.
    }
  }
  return files;
}

/**
 * The shared libraries only Linger and its WebKit processes have loaded:
 * after a restart, with no other WebKitGTK app open, these are what a first
 * open reads from disk on top of Linger's own files. Another running Linger
 * keeps them in memory, so a "boot" run starts the app with fresh copies of
 * them instead (same bytes, nothing cached), each under its library name,
 * through LD_LIBRARY_PATH.
 */
function shadowLibraries(files, dir) {
  const elsewhere = new Set();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = readlinkSync(`/proc/${entry}/exe`);
      if (/linger-client|\/webkit2gtk-4\.1\//.test(exe)) continue;
      for (const line of readFileSync(`/proc/${entry}/maps`, "utf8").split("\n")) elsewhere.add(line.split(/\s+/).slice(5).join(" "));
    } catch {
      // Not ours to read, or gone.
    }
  }
  mkdirSync(dir, { recursive: true });
  const copies = [];
  for (const file of files) {
    if (!/\.so(\.|$)/.test(file) || elsewhere.has(file) || !file.startsWith("/usr/")) continue;
    const soname = /\(SONAME\)\s+Library soname: \[([^\]]+)\]/.exec(spawnSync("readelf", ["-d", file], { encoding: "utf8" }).stdout ?? "")?.[1];
    if (!soname) continue;
    const copy = join(dir, soname);
    if (!existsSync(copy)) execFileSync("cp", ["--reflink=auto", file, copy]);
    copies.push(copy);
  }
  return copies;
}

function walk(dir, into = []) {
  if (!existsSync(dir)) return into;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, into);
    else if (entry.isFile()) into.push(path);
  }
  return into;
}

/** Ask the kernel to drop these files' cached pages. What another program has mapped stays. */
function evict(files) {
  for (const file of files) spawnSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"]);
}

/**
 * What a cold start still finds in memory, in MB: of the files you own (the
 * app and its profile), what is still cached, which the kernel will say; and
 * the files some other running program has loaded, which nothing short of
 * root can push out and the kernel won't say how much of for files you don't
 * own, so their whole size counts.
 */
function warmth(files) {
  const uid = process.getuid();
  const own = [...files].filter((file) => existsSync(file) && statSync(file).uid === uid);
  const out = own.length ? spawnSync("fincore", ["--bytes", "--noheadings", "--output", "RES", ...own], { encoding: "utf8" }).stdout : "";
  const ownMb = out.split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) / 1e6;
  const inUse = new Set();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      for (const line of readFileSync(`/proc/${entry}/maps`, "utf8").split("\n")) {
        const path = line.split(/\s+/).slice(5).join(" ");
        if (files.has(path)) inUse.add(path);
      }
    } catch {
      // Not ours to read, or gone.
    }
  }
  const shared = [...inUse].map((file) => ({ file, mb: statSync(file).size / 1e6 })).sort((a, b) => b.mb - a.mb);
  return { ownMb: Math.round(ownMb), sharedMb: Math.round(shared.reduce((sum, one) => sum + one.mb, 0)), largestShared: shared.slice(0, 5).map((one) => `${one.file} (${Math.round(one.mb)} MB)`) };
}

async function stop(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  }
  for (let i = 0; i < 50 && pids.some((pid) => existsSync(`/proc/${pid}`)); i++) await sleep(100);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

/** One line about one launch, for the log. */
function describe(run) {
  const servers = run.servers.map((server) => `asked ${server.firstRequestMs}, gateway ${server.gatewayMs}, ${server.requests} requests`).join("; ");
  return `${run.kind}: window ${run.windowMs} ms, first paint ${run.firstPaintMs}, open ${run.openMs} (±${run.openUncertaintyMs}), ${Math.round(run.memory.pss / 1024)} MB; ${servers}${run.signedIn ? "" : "; NOT SIGNED IN"}; load ${run.loadavg}`;
}

/** One launch: start the app, watch its window, and say when it was open. */
async function launch({ kind, launcher, profile, events, proxies, evictFiles, runDir, minMs, maxMs, idleSeconds, film }) {
  mkdirSync(runDir, { recursive: true });
  let coldness = null;
  if (kind === "cold" || kind === "boot") {
    evict(evictFiles);
    coldness = warmth(evictFiles);
  }
  const load = loadavg()[0];
  const windowAppears = events.next(30_000);
  const requested = now();
  lua(`hl.exec_cmd("${launcher}${kind === "boot" ? " boot" : ""}", {workspace="name:${WORKSPACE} silent", float=true, no_anim=true})`);
  const shown = await windowAppears;
  const client = JSON.parse(hyprctl("clients", "-j")).find((one) => one.address === shown.address);
  const region = `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`;
  const frames = [];
  let checked = 0;
  for (;;) {
    const shot = await grab(region);
    if (shot) frames.push({ at: shot.at, started: shot.started, image: shrink(parsePpm(shot.buffer)) });
    const elapsed = now() - requested;
    if (elapsed > maxMs) break;
    // Done once it has held still for a while; checked twice a second, as the check isn't free.
    if (elapsed > minMs && now() - checked > 500) {
      checked = now();
      const check = settled(frames);
      if (check.done !== null && check.moving < 0.05) break;
    }
  }
  spawnSync("grim", ["-g", region, join(runDir, "settled.png")]);
  const [t0, pid] = readFileSync(join(profile, "launch"), "utf8").trim().split(" ").map(Number);
  const start = t0 * 1000;
  const result = settled(frames);
  if (film) {
    // Every photograph that differs from the one before, named by its ms after the start, to look at.
    mkdirSync(join(runDir, "film"), { recursive: true });
    frames.forEach((frame, index) => {
      if (index > 0 && Buffer.compare(Buffer.from(frame.image.data), Buffer.from(frames[index - 1].image.data)) === 0) return;
      const { width, height, data } = frame.image;
      writeFileSync(join(runDir, "film", `${String(Math.round(frame.at - start)).padStart(5, "0")}.ppm`), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), Buffer.from(data)]));
    });
  }
  const run = {
    kind,
    loadavg: Math.round(load * 10) / 10,
    stillCached: coldness,
    launcherMs: Math.round(start - requested),
    windowMs: Math.round(shown.at - start),
    firstPaintMs: result.blank === null ? null : Math.round(frames[result.blank].at - start),
    openMs: result.done === null ? null : Math.round(frames[result.done].at - start),
    // The photograph that first showed it was asked for this long before it came back.
    openUncertaintyMs: result.done === null ? null : Math.round(frames[result.done].at - (result.done > 0 ? frames[result.done - 1].started : start)),
    frames: frames.length,
    moving: Math.round(result.moving * 1000) / 10,
    // When each server first heard from this launch: its sign-in, its
    // gateway, and how many requests it had by the time the list settled.
    servers: proxies.map((relay) => {
      const mine = relay.events.filter((event) => event.at >= requested && event.at <= frames[frames.length - 1].at);
      const first = (kind) => {
        const event = mine.find((one) => one.kind === kind);
        return event ? Math.round(event.at - start) : null;
      };
      return {
        firstRequestMs: first("request"),
        gatewayMs: first("upgrade"),
        requests: mine.filter((one) => one.kind === "request").length,
        // What it asked for and when, ids and all: these are throwaway servers.
        asked: mine.map((one) => `${Math.round(one.at - start)} ${one.method ?? "GET"} ${one.path}`),
      };
    }),
  };
  run.signedIn = run.servers.every((server) => server.gatewayMs !== null);
  await sleep(Math.max(0, start + 8000 - now()));
  const pids = tree(pid);
  // When each process the app started began, after the app itself: the
  // kernel keeps it in hundredths of a second.
  try {
    const began = startTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
    run.started = pids.slice(1).map((one) => ({
      name: readFileSync(`/proc/${one}/comm`, "utf8").trim(),
      ms: (startTicks(readFileSync(`/proc/${one}/stat`, "utf8")) - began) * 10,
    }));
  } catch {
    // Gone already.
  }
  run.memory = treeMemory(pids);
  run.processes = pids.length;
  if (idleSeconds > 0) {
    await sleep(10_000);
    const before = treeTicks(tree(pid));
    const began = now();
    await sleep(idleSeconds * 1000);
    const after = treeTicks(tree(pid));
    const seconds = (now() - began) / 1000;
    // One core's worth is 100%; clock ticks are 100 a second on Linux.
    const percent = (ticks) => Math.round((ticks / 100 / seconds) * 1000) / 10;
    const each = [...after].map(([one, { name, ticks }]) => ({ name, percent: percent(ticks - (before.get(one)?.ticks ?? 0)) }));
    run.idleCpuPercent = percent([...after].reduce((sum, [one, { ticks }]) => sum + ticks - (before.get(one)?.ticks ?? 0), 0));
    run.idleCpuByProcess = each.filter((one) => one.percent > 0);
    run.memoryAfterIdle = treeMemory(tree(pid));
  }
  const files = filesOf(pids);
  await stop(tree(pid));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return { run, files };
}

/** The next port from `from` that nothing is listening on, skipping `taken`. */
async function freePort(from, taken) {
  for (let port = from; port < from + 100; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port from ${from}`);
}

/**
 * Everything one build needs before its first open: two servers of its own,
 * filled; a proxy in front of each; a profile and keyring signed in to both;
 * and the script that opens it.
 */
async function prepare({ label, app, server, env }, { out, ports, rtt, a11y, shimmer, cleanups }) {
  const dir = join(out, label);
  const profile = join(dir, "profile");
  for (const kind of ["config", "data", "cache", "state"]) mkdirSync(join(profile, kind), { recursive: true, mode: 0o700 });
  // The desktop's own look (dark or light, fonts) as a real start reads it;
  // Linger's own settings and sign-ins stay in this profile.
  const home = process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config");
  for (const name of ["dconf", "fontconfig", "gtk-3.0"]) if (existsSync(join(home, name))) symlinkSync(join(home, name), join(profile, "config", name));
  const layouts = [
    plan({ seed: 1, name: "The Porch", people: 22, rooms: ["general", "games", "music", "raid-night", "photos", "food", "late-night", "books"], messages: 1600, dms: [2, 2, 4], online: 7, shimmer }),
    plan({ seed: 2, name: "Raid night", people: 11, rooms: ["general", "strats", "loot", "off-topic"], messages: 350, dms: [2], online: 3, shimmer }),
  ];
  // Both servers fill at once; posting is paced by the server, not this machine.
  const filled = await Promise.all(layouts.map(async (layout, index) => {
    const running = await startServer(server, ports[index], join(dir, `server-${index + 1}`));
    cleanups.push(() => stop([running.child.pid]));
    const began = now();
    const accounts = await seed(running, layout);
    log(`${label}: ${layout.name}: ${layout.names.length} people, ${layout.rooms.length} rooms, ${layout.posts.length} messages and ${layout.dms.length} DMs in ${Math.round((now() - began) / 1000)} s`);
    layout.around.forEach((around, person) => around && cleanups.push(online(running.base, accounts[person])));
    // The app reaches each server through a proxy that notes when it asked.
    const relay = startProxy(ports[2 + index], ports[index], rtt);
    cleanups.push(() => stop([relay.child.pid]));
    await relay.listening;
    return { relay, session: { base_url: relay.base, refresh_token: accounts[layout.me].refresh_token } };
  }));
  // A socket's path has to be short, so the bus lives in the runtime directory.
  const runtime = join(process.env.XDG_RUNTIME_DIR, `linger-startup-${ports[0]}`);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  cleanups.push(() => rmSync(runtime, { recursive: true, force: true }));
  const bus = keyring(runtime, profile, filled.map((one) => one.session), cleanups);
  const launcher = join(dir, "launch.sh");
  writeFileSync(launcher, [
    "#!/usr/bin/env bash",
    "# Opens Linger with this measurement's own profile and keyring. The time and",
    "# pid are written before exec, so they are the app's own.",
    ...Object.entries({
      DBUS_SESSION_BUS_ADDRESS: bus.address,
      XDG_CONFIG_HOME: join(profile, "config"),
      XDG_DATA_HOME: join(profile, "data"),
      XDG_CACHE_HOME: join(profile, "cache"),
      XDG_STATE_HOME: join(profile, "state"),
      GNOME_KEYRING_CONTROL: join(runtime, "keyring"),
      // The desktop's own accessibility bus, as a real start finds it.
      ...(a11y ? { AT_SPI_BUS_ADDRESS: a11y } : { NO_AT_BRIDGE: "1" }),
      // What --env asked for, to see what a setting changes.
      ...env,
    }).map(([key, value]) => `export ${key}='${value}'`),
    "for name in $(compgen -e | grep '^LINGER_'); do unset \"$name\"; done",
    `if [ "\${1:-}" = boot ]; then export LD_LIBRARY_PATH='${join(dir, "shadow")}'; fi`,
    `printf '%s %s\\n' "\${EPOCHREALTIME/,/.}" "$$" > '${join(profile, "launch")}'`,
    `exec '${app}' >> '${join(dir, "app.log")}' 2>&1`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { label, app, dir, profile, launcher, keyring: bus.daemon, proxies: filled.map((one) => one.relay), runs: [], evictFiles: null, idle: null };
}

/** What one build's launches add up to. */
function report(build, rtt, idleSeconds) {
  const { runs } = build;
  // A launch that never reached both servers didn't open the list; it says so in its run.json.
  const pick = (kind, key) => runs.filter((run) => run.kind === kind && run.signedIn).map((run) => run[key]);
  const pickServer = (kind, key) => runs.filter((run) => run.kind === kind && run.signedIn).map((run) => Math.max(...run.servers.map((server) => server[key])));
  const mb = (kb) => Math.round(kb / 1024);
  const timings = (kind) => ({ window: summary(pick(kind, "windowMs")), firstPaint: summary(pick(kind, "firstPaintMs")), open: summary(pick(kind, "openMs")) });
  const warmMemory = runs.filter((run) => run.kind === "warm").map((run) => run.memory);
  const first = runs.find((run) => run.kind === "first");
  return {
    label: build.label,
    date: new Date().toISOString(),
    machine: { cpu: cpus()[0].model, cores: cpus().length, kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(), hyprland: hyprctl("version").split("\n")[0] },
    app: { path: build.app, bytes: statSync(build.app).size },
    first: first && { window: first.windowMs, firstPaint: first.firstPaintMs, open: first.openMs },
    boot: { ...timings("boot"), ownCachedMb: summary(pick("boot", "stillCached").map((one) => one.ownMb)) },
    cold: { ...timings("cold"), ownCachedMb: summary(pick("cold", "stillCached").map((one) => one.ownMb)), sharedMb: summary(pick("cold", "stillCached").map((one) => one.sharedMb)) },
    warm: timings("warm"),
    // The later of the two servers, each time: when both had been asked, and when both gateways were connected.
    servers: Object.fromEntries(["boot", "cold", "warm"].map((kind) => [kind, { firstRequest: summary(pickServer(kind, "firstRequestMs")), gateway: summary(pickServer(kind, "gatewayMs")) }])),
    notSignedIn: runs.filter((run) => !run.signedIn).length,
    rttMs: rtt,
    memoryMb: {
      pss: summary(warmMemory.map((one) => mb(one.pss))),
      rss: summary(warmMemory.map((one) => mb(one.rss))),
      uss: summary(warmMemory.map((one) => mb(one.uss))),
    },
    idle: build.idle && { cpuPercent: build.idle.idleCpuPercent, byProcess: build.idle.idleCpuByProcess, seconds: idleSeconds, pssMb: mb(build.idle.memoryAfterIdle.pss) },
    loadavg: summary(runs.map((run) => run.loadavg * 10)).median / 10,
    runs,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: "string", multiple: true },
      server: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      out: { type: "string" },
      runs: { type: "string", default: "7" },
      port: { type: "string", default: "18610" },
      idle: { type: "string", default: "60" },
      rtt: { type: "string", default: "0" },
      film: { type: "boolean", default: false },
      "no-shimmer": { type: "boolean", default: false },
      env: { type: "string", multiple: true },
    },
  });
  const usage = "usage: node scripts/startup-time.mjs --app PATH --server PATH [--label NAME] [--app PATH --server PATH --label NAME …] --out DIR [--runs 7] [--port 18610] [--idle 60] [--rtt 0] [--film] [--no-shimmer] [--env N:KEY=VALUE …]";
  if (!values.app?.length || values.server?.length !== values.app.length || !values.out) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    console.error("This needs Hyprland: it watches the screen with grim on a screen of its own.");
    process.exit(2);
  }
  const out = resolve(values.out);
  if (existsSync(out)) {
    console.error(`${out} already exists; every measurement starts from nothing`);
    process.exit(1);
  }
  // Two or more builds take turns, launch by launch, so whatever else the
  // machine is doing weighs on each of them alike.
  const wanted = values.app.map((app, index) => ({ label: values.label?.[index] ?? `build-${index + 1}`, app: resolve(app), server: resolve(values.server[index]), env: {} }));
  // --env 2:GDK_GL=disable sets that for the second build's launches only.
  for (const one of values.env ?? []) {
    const match = /^(\d+):([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(one);
    if (!match || !wanted[Number(match[1]) - 1] || match[3].includes("'")) {
      console.error(`--env ${one}: give it as BUILD:KEY=VALUE, BUILD counting --app from 1`);
      process.exit(2);
    }
    wanted[Number(match[1]) - 1].env[match[2]] = match[3];
  }
  const rtt = Number(values.rtt);
  const idleSeconds = Number(values.idle);

  const cleanups = [];
  const cleanup = async () => {
    for (const step of cleanups.reverse()) {
      try {
        await step();
      } catch (error) {
        console.error(`cleanup: ${error.message}`);
      }
    }
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
  try {
    const taken = new Set();
    const a11y = spawnSync("gdbus", ["call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.a11y.Bus.GetAddress"], { encoding: "utf8" }).stdout?.match(/'([^']+)'/)?.[1];
    const builds = [];
    for (const one of wanted) {
      const ports = [];
      for (let i = 0; i < 4; i++) ports.push(await freePort(Number(values.port), taken));
      builds.push(prepare(one, { out, ports, rtt, a11y, shimmer: !values["no-shimmer"], cleanups }));
    }
    const ready = await Promise.all(builds);

    cleanups.push(benchScreen());
    const events = windowEvents();
    cleanups.push(() => events.close());
    await sleep(1000);
    const common = { events, minMs: 6000, maxMs: 30_000, idleSeconds: 0, film: values.film };
    const open = (build, kind, name, extra = {}) => {
      // gnome-keyring has been seen to crash (an assertion in its session
      // code); without it the app opens signed out, which measures nothing.
      if (!build.keyring.some((pid) => existsSync(`/proc/${pid}`))) throw new Error(`${build.label}'s throwaway keyring stopped; start again`);
      return launch({ ...common, kind, launcher: build.launcher, profile: build.profile, proxies: build.proxies, evictFiles: build.evictFiles ?? [], runDir: join(build.dir, "runs", name), ...extra });
    };

    for (const build of ready) {
      // The very first open: a new profile, nothing cached by WebKit yet.
      const first = await open(build, "first", "00-first");
      build.runs.push(first.run);
      log(`${build.label}: ${describe(first.run)}`);
      if (!first.run.signedIn) throw new Error(`${build.label} never reached both servers; see ${join(build.dir, "runs", "00-first", "settled.png")}`);
      build.evictFiles = new Set([build.app, ...first.files, ...walk(build.profile)]);
      const shadows = shadowLibraries(first.files, join(build.dir, "shadow"));
      shadows.forEach((file) => build.evictFiles.add(file));
      log(`${build.label}: a boot run reads ${shadows.length} libraries only Linger uses from disk, ${Math.round(shadows.reduce((sum, file) => sum + statSync(file).size, 0) / 1e6)} MB`);
      await sleep(2000);
    }
    for (let i = 1; i <= Number(values.runs); i++) {
      for (const build of ready) {
        for (const kind of ["boot", "cold", "warm"]) {
          await sleep(2000);
          const one = await open(build, kind, `${String(i).padStart(2, "0")}-${kind}`);
          one.files.forEach((file) => build.evictFiles.add(file));
          walk(build.profile).forEach((file) => build.evictFiles.add(file));
          build.runs.push(one.run);
          log(`${build.label} ${i}: ${describe(one.run)}`);
        }
      }
    }
    if (idleSeconds > 0) {
      screenRate(60);
      for (const build of ready) {
        await sleep(2000);
        log(`${build.label}: left open for ${idleSeconds} s to measure idle processor use`);
        build.idle = (await open(build, "idle", "99-idle", { idleSeconds })).run;
      }
    }
    const results = ready.map((build) => report(build, rtt, idleSeconds));
    for (const result of results) writeFileSync(join(out, result.label, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(results.map((result) => ({ ...result, runs: undefined })), null, 2));
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--proxy") {
  proxy(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
