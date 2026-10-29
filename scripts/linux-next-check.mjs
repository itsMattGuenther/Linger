#!/usr/bin/env node
// Check the Buddy list client starts in a packaged Linux WebView (T-1812).
//
// Runs the unchanged package on a private virtual display with an empty profile
// and no account, injects client/scripts/next-smoke-probe.js through the same
// test-only GTK module the audio check uses, and waits for its verdict: among
// the rest, an H.264 video in a <video> element, as a chat shows one, must
// show its picture, and a voice message and an MP3 must play (#756). Then it
// checks WebKit's network process speaks
// HTTP/1.1 only (#646), and that its web process keeps the hardware H.264 and
// VP8 decoders out (#730) and copies software-decoded video itself (#756).
// Requires cc, pkg-config, WebKitGTK/GStreamer headers, Xvfb and D-Bus. The
// Windows version of this check is client/scripts/windows-next-check.mjs.
//
// Usage: node scripts/linux-next-check.mjs PROGRAM --output DIR [--appimage]
//          [--webkit-gpu] [--gdk-gl-disable] [--h264]
//          [--render-device PATH --draws-with LIBRARY]
//
// By default WebKit's GPU paths are off, as CI's runners need for Ubuntu's
// WebKit, and the app must then say it can't play a shared screen (#729).
// --webkit-gpu leaves them on, as on a person's computer: the app must say
// it plays one, and must really play VP8 (and H.264 with --h264).
// --gdk-gl-disable starts it as on NVIDIA's legacy driver (#229): it must
// say it can't, and not crash. `scripts/linux-arch-check.sh` runs these on
// Arch's own WebKit, and with this machine's GPUs before a release.
// --render-device has WebKit's pages draw on that graphics device
// (`WEBKIT_WEB_RENDER_DEVICE_FILE`), with WebKit's GBM path on, as a native
// Wayland desktop has it (on X11 Linger keeps it off). --draws-with fails the
// check unless WebKit's page process loaded that library, so a run meant for
// one driver can't quietly draw with another: WebGL can't say, since WebKit
// names every GPU "Apple GPU". The GPU check runs on NVIDIA's own EGL this
// way (`libnvidia-eglcore`), where #756 showed.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    appimage: { type: "boolean", default: false },
    output: { type: "string" },
    "webkit-gpu": { type: "boolean", default: false },
    "gdk-gl-disable": { type: "boolean", default: false },
    h264: { type: "boolean", default: false },
    "render-device": { type: "string" },
    "draws-with": { type: "string" },
  },
});
if (positionals.length !== 1 || values.output === undefined) {
  console.error("usage: node scripts/linux-next-check.mjs PROGRAM --output DIR [--appimage] [--webkit-gpu] [--gdk-gl-disable] [--h264]");
  process.exit(2);
}
const program = resolve(positionals[0]);
const output = resolve(values.output);

// A fresh evidence folder every time: an old result.json would pass the check.
mkdirSync(dirname(output), { recursive: true });
try {
  mkdirSync(output);
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.error(`FAIL ${output} already exists; the check writes its evidence into a new folder`);
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (["GST_", "PULSE_", "APPIMAGE", "APPDIR", "GTK3_MODULES", "LINGER_", "SOUP_"].some((prefix) => key.startsWith(prefix))) delete env[key];
}
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "LD_LIBRARY_PATH"]) delete env[key];
for (const kind of ["config", "data", "cache", "state", "runtime"]) {
  const path = join(output, kind);
  mkdirSync(path, { mode: 0o700 });
  env[kind === "runtime" ? "XDG_RUNTIME_DIR" : `XDG_${kind.toUpperCase()}_HOME`] = path;
}
Object.assign(env, {
  GDK_BACKEND: "x11",
  LINGER_LINUX_BACKEND: "x11",
  NO_AT_BRIDGE: "1",
  XDG_CURRENT_DESKTOP: "GNOME",
  GTK_OVERLAY_SCROLLING: "0",
});
for (const key of ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"]) delete env[key];
if (!values["webkit-gpu"]) Object.assign(env, { WEBKIT_DISABLE_DMABUF_RENDERER: "1", WEBKIT_DISABLE_COMPOSITING_MODE: "1" });
if (values["gdk-gl-disable"]) env.GDK_GL = "disable";
else delete env.GDK_GL;
for (const key of ["WEBKIT_WEB_RENDER_DEVICE_FILE", "WEBKIT_DMABUF_RENDERER_DISABLE_GBM", "WEBKIT_DMABUF_RENDERER_FORCE_SHM"]) delete env[key];
if (values["render-device"] !== undefined) {
  env.WEBKIT_WEB_RENDER_DEVICE_FILE = values["render-device"];
  // Somebody's own setting wins over Linger's choice (linux_startup.rs), so
  // this keeps GBM on under X11, as Wayland has it, and pages go to that device.
  env.WEBKIT_DMABUF_RENDERER_DISABLE_GBM = "0";
}
// Whether the app should say it plays a shared screen, as started: not where
// WebKit draws on the CPU (#729, `screen_shell::draws_on_cpu`).
const plays = values["webkit-gpu"] && !values["gdk-gl-disable"];

const module = join(output, "probe.so");
const flags = execFileSync("pkg-config", ["--cflags", "--libs", "webkit2gtk-4.1", "gstreamer-1.0"], { encoding: "utf8" }).trim().split(/\s+/);
execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", join(ROOT, "scripts/linux-audio-check.c"), "-o", module, ...flags], { stdio: "inherit" });
const resultPath = join(output, "result.json");
Object.assign(env, {
  GTK3_MODULES: module,
  LINGER_AUDIO_RESULT: resultPath,
  LINGER_AUDIO_SCRIPT: join(ROOT, "client/scripts/next-smoke-probe.js"),
  GST_REGISTRY_1_0: join(output, "gst-registry.bin"),
});
if (values.appimage) env.APPIMAGE_EXTRACT_AND_RUN = "1";

const log = openSync(join(output, "app.log"), "w");
// Its own process group, so stopping it stops Xvfb, D-Bus and the app together.
const app = spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x900x24", "dbus-run-session", "--", program], {
  env,
  stdio: ["ignore", log, log],
  detached: true,
});
closeSync(log);
const exited = new Promise((settle) => app.once("exit", settle));
let launchError;
app.once("error", (error) => {
  launchError = error;
});

/** Stop the whole group: politely, then for certain after five seconds. */
async function stop() {
  if (app.exitCode !== null || app.signalCode !== null || app.pid === undefined) return;
  const group = (signal) => {
    try {
      process.kill(-app.pid, signal);
    } catch {
      // Already gone.
    }
  };
  group("SIGTERM");
  if ((await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) === false) {
    group("SIGKILL");
    await exited;
  }
}

/** Every process started under `root`, however deep, by each one's parent. */
function descendants(root) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // Gone already.
    }
    // The name sits in brackets and may hold spaces; the parent is the
    // second field after it.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
  }
  const found = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * The window's requests go through WebKit's network process. Its libsoup must
 * speak HTTP/1.1 only: over HTTP/2 every request shares one connection, and
 * one that died while the computer slept swallowed the token refresh for
 * about 15 minutes (#646). So the process must have `SOUP_FORCE_HTTP1`, and
 * the libsoup it loaded (the bundled copy, in the AppImage) must still read it.
 */
async function checkHttp1() {
  let network = [];
  for (let attempt = 0; attempt < 50 && network.length === 0; attempt++) {
    if (attempt > 0) await sleep(100);
    network = descendants(app.pid).filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "WebKitNetworkPr";
      } catch {
        return false;
      }
    });
  }
  if (network.length === 0) throw new Error("No WebKit network process under the app");
  const libraries = new Set();
  for (const pid of network) {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    if (!environ.some((entry) => entry.startsWith("SOUP_FORCE_HTTP1="))) {
      throw new Error(`WebKit's network process (${pid}) can use HTTP/2: it has no SOUP_FORCE_HTTP1 (#646)`);
    }
    const library = readFileSync(`/proc/${pid}/maps`, "utf8").match(/\/\S*libsoup-3\.0\.so\S*/)?.[0];
    if (library === undefined) throw new Error(`WebKit's network process (${pid}) has no libsoup 3 loaded`);
    if (!readFileSync(library).includes("SOUP_FORCE_HTTP1")) {
      throw new Error(`${library} no longer reads SOUP_FORCE_HTTP1, so Linger's window can use HTTP/2 (#646)`);
    }
    libraries.add(library);
  }
  return [...libraries].map((library) => basename(library));
}

/** WebKit's page processes under the app, once there's one. */
async function webProcesses() {
  let pages = [];
  for (let attempt = 0; attempt < 50 && pages.length === 0; attempt++) {
    if (attempt > 0) await sleep(100);
    pages = descendants(app.pid).filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "WebKitWebProces";
      } catch {
        return false;
      }
    });
  }
  if (pages.length === 0) throw new Error("No WebKit web process under the app");
  return pages;
}

/**
 * Whether a page process drew with `library` (`--draws-with`): loaded in its
 * memory map, by any version.
 */
async function checkDrawsWith(library) {
  const pages = await webProcesses();
  const drawing = pages.filter((pid) => readFileSync(`/proc/${pid}/maps`, "utf8").includes(`/${library}.so`));
  if (drawing.length === 0) throw new Error(`no page process loaded ${library}, so this run didn't draw where it's meant to`);
}

/**
 * A shared screen is decoded in WebKit's web process, by GStreamer's
 * highest-ranked decoder. Linger ranks the hardware H.264 and VP8 ones out,
 * since WebKit hands them input they refuse and the screen says "This device
 * can't play" (#730). So every web process must have them in
 * `GST_PLUGIN_FEATURE_RANK`. That puts a chat video's H.264 in software too,
 * whose frames GStreamer's GL upload loses on NVIDIA (#756), so every web
 * process must also have `WEBKIT_GST_DISABLE_GL_SINK=1`: WebKit copies them
 * itself.
 */
async function checkMediaSettings() {
  const pages = await webProcesses();
  for (const pid of pages) {
    const ranks = readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .find((entry) => entry.startsWith("GST_PLUGIN_FEATURE_RANK="));
    const pairs = (ranks ?? "").slice("GST_PLUGIN_FEATURE_RANK=".length).split(",");
    for (const decoder of ["nvh264dec", "nvvp8dec", "vah264dec", "vavp8dec"]) {
      if (!pairs.includes(`${decoder}:NONE`)) {
        throw new Error(`WebKit's web process (${pid}) can decode a shared screen with ${decoder}, which refuses WebKit's input (#730)`);
      }
    }
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    if (!environ.includes("WEBKIT_GST_DISABLE_GL_SINK=1")) {
      throw new Error(`WebKit's web process (${pid}) hands software-decoded video to GStreamer's GL upload, which shows it green on NVIDIA (#756)`);
    }
  }
  return pages.length;
}

let failure = null;
try {
  let result = null;
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(resultPath)) {
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch {
        // Still being written.
      }
      if (result && result.status !== "pending") break;
    }
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error("Packaged client exited; see app.log");
    await sleep(100);
  }
  if (result?.status !== "passed") throw new Error(`The Buddy list didn't start: ${JSON.stringify(result)}; see ${output}`);
  console.log(`PASS ${basename(program)}: the Buddy list starts in the packaged WebView: ${JSON.stringify(result.checks)}`);
  const { watch, screens, video, sounds } = result.checks;
  const drawsWith = values["draws-with"];
  if (drawsWith !== undefined) {
    await checkDrawsWith(drawsWith);
    console.log(`PASS ${basename(program)}: the page draws with ${drawsWith}`);
  }
  // Every way the app is started, a chat's video shows its picture (#756).
  if (video !== "plays") throw new Error(`a video in a conversation doesn't show its picture${drawsWith ? `, drawn with ${drawsWith}` : ""}: ${video} (#756)`);
  console.log(`PASS ${basename(program)}: a video in a conversation shows its picture (#756)`);
  // And its voice messages and sound files play, through the same player.
  if (sounds?.voice !== "plays" || sounds?.file !== "plays") throw new Error(`a voice message or sound file in a conversation doesn't play: ${JSON.stringify(sounds)} (#756)`);
  console.log(`PASS ${basename(program)}: a voice message and a sound file in a conversation play (#756)`);
  if (watch !== plays) {
    throw new Error(`the app says ${JSON.stringify(watch)} to playing a shared screen, started ${plays ? "with WebKit's GPU path" : "with WebKit drawing on the CPU"}, where it should say ${plays} (#729)`);
  }
  if (plays) {
    if (screens?.vp8 !== "plays") throw new Error(`a shared screen in VP8 doesn't play: ${screens?.vp8}`);
    if (values.h264 && screens?.avc1 !== "plays") throw new Error(`a shared screen in H.264, as Windows sends it, doesn't play: ${screens?.avc1} (#730)`);
    console.log(`PASS ${basename(program)}: a shared screen plays: VP8 ${screens.vp8}, H.264 ${screens.avc1}`);
  } else {
    if (screens !== null) throw new Error("the probe decoded a screen where the app says it can't play one");
    console.log(`PASS ${basename(program)}: where WebKit draws on the CPU, the app says it can't play a shared screen, and doesn't crash (#729)`);
  }
  const libraries = await checkHttp1();
  console.log(`PASS ${basename(program)}: WebKit's network process speaks HTTP/1.1 only (${libraries.join(", ")})`);
  const pages = await checkMediaSettings();
  console.log(`PASS ${basename(program)}: ${pages === 1 ? "WebKit's web process decodes" : "WebKit's web processes decode"} shared screens in software (#730), and copies software-decoded video itself (#756)`);
} catch (error) {
  failure = error;
} finally {
  await stop();
}
if (failure) {
  console.error(`FAIL ${failure instanceof Error ? failure.message : failure}`);
  process.exit(1);
}
