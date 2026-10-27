// Sharing a screen from the installed Windows app (#360, SPEC §4.20), in its
// real WebView2: what the Windows share needs, checked where it runs.
//
// - The page asks for the screen as Share does (`getDisplayMedia`, from a
//   press, since it opens only from one), and WebView2's picker, told by a
//   test switch to choose the whole screen, answers with a screen.
// - The frames come through the track processor, as lib/screen/share.ts
//   reads them, and VP8 encodes them at 1080p and 60 frames a second;
//   H.264 too where the runner has a hardware encoder (a runner has no
//   graphics card, so it's reported, not required).
// - Frames keep coming and encoding with the window minimized: a slide show
//   covers Linger, and the share mustn't stop when it does.
// - The computer's sound (#736): the shell says this Windows can capture it,
//   and starting it from the list window answers. Where the runner plays
//   sound, another program's tone is in what it captures, and Linger's own,
//   from the shell (voice and chimes) and from the page (WebView2), aren't:
//   the echo the capture exists to keep out.
// - Then again without the test switch, as a person meets it: a press opens
//   WebView2's own picker (a picture of it is kept), and Escape closes it
//   with the share refused, which Share takes as nothing to say.
//
// Nothing goes to a server: the screen socket and the server are
// crates/linger-server/tests/screen.rs and scripts/screen-loop.mjs. What
// was picked is never read: no label, no settings (hard rule 2).
//
// Runs on a disposable Windows runner only, after windows-icon-check.ps1 has
// installed the app; launches only that app, with an empty profile. Usage:
//   node client/scripts/windows-screen-check.mjs <installed exe> <evidence dir>
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
const results = [];
function verdict(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${JSON.stringify(detail)}`);
  return ok;
}
const note = (what) => console.log(`NOTE ${what}`);

/** A WAV file of a `hz` tone, `seconds` long, at half strength: 48 kHz, 16 bits, one channel. */
function toneWav(hz, seconds) {
  const frames = 48000 * seconds;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + frames * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at += 1) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * at) / 48000) * 16000), 44 + at * 2);
  return wav;
}

// The Win32 helper, as windows-hidden-check.mjs uses it.
const helper = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./windows-window.ps1", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = [];
createInterface({ input: helper.stdout }).on("line", (line) => {
  if (!line.startsWith("LINGER-REPLY ")) return;
  replies.shift()?.(JSON.parse(line.slice("LINGER-REPLY ".length)));
});
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

/**
 * Start the installed app under the test policy, with `switches` added to
 * WebView2's own, and find its list window's page and window.
 */
async function launch(switches, profile, logName) {
  // HKLM app-specific WebView2 policy, as the other checks set it, removed
  // after.
  for (const [setting, value] of [
    ["AdditionalBrowserArguments", `--remote-debugging-port=${port} ${switches}`.trim()],
    ["UserDataFolder", resolve(output, profile)],
  ]) {
    const key = `HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\${setting}`;
    assert.notEqual(spawnSync("reg", ["query", key, "/v", appName], { stdio: "ignore" }).status,
      0, `Refusing to replace an existing ${setting} policy for ${appName}`);
    const changed = spawnSync("reg", ["add", key, "/v", appName, "/t", "REG_SZ", "/d", value, "/f"], { encoding: "utf8" });
    assert.equal(changed.status, 0, changed.stderr);
    policyKeys.push(key);
  }
  const log = openSync(resolve(output, logName), "w");
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
  return { page, hwnd };
}

/** Stop the app and take the test policy away. */
async function shutDown() {
  if (browser) await browser.close().catch(() => undefined);
  browser = undefined;
  if (app?.pid) {
    spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    if (app.exitCode === null) await new Promise((settle) => { app.once("exit", settle); setTimeout(settle, 10000); });
  }
  app = undefined;
  for (const key of policyKeys.splice(0)) {
    const removed = spawnSync("reg", ["delete", key, "/v", appName, "/f"], { encoding: "utf8" });
    if (removed.status !== 0) verdict("the test policy is removed", false, { key, stderr: removed.stderr });
  }
}

/** A button on the page that asks for a screen as Share does, from a press. */
async function addProbe(page, onScreen) {
  await page.evaluate(() => {
    window.__lingerScreenCheck = { status: "waiting", error: null, frames: 0, vp8: { chunks: 0, bytes: 0, keys: 0 }, avc: { chunks: 0, bytes: 0, keys: 0 }, size: null, stop: false };
    const button = document.createElement("button");
    button.id = "linger-screen-probe";
    button.textContent = "share";
    Object.assign(button.style, { position: "fixed", left: "0", top: "0", zIndex: "99999" });
    document.body.append(button);
  });
  await page.evaluate(onScreen);
}

async function statusAfterPress(page) {
  // A real press, through the debugging port, so the page has a person's press.
  await page.click("#linger-screen-probe");
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await page.evaluate(() => window.__lingerScreenCheck.status);
    if (status !== "waiting") break;
    await sleep(250);
  }
  return page.evaluate(() => ({ ...window.__lingerScreenCheck }));
}

try {
  // The two capture switches are Chromium's own for tests: the picker
  // chooses the whole screen by itself, which a person does by hand.
  const { page, hwnd } = await launch(`--auto-select-desktop-capture-source="Entire screen" --enable-usermedia-screen-capturing`, "profile", "app.log");

  // 1. What this WebView2 has.
  const has = await page.evaluate(async () => {
    const test = async (kind, config) => {
      try {
        return (await (kind === "encode" ? VideoEncoder : VideoDecoder).isConfigSupported(config)).supported === true;
      } catch {
        return false;
      }
    };
    const at = { width: 1920, height: 1080, bitrate: 6_000_000, framerate: 60, latencyMode: "realtime" };
    return {
      webCodecs: typeof VideoEncoder === "function" && typeof VideoDecoder === "function",
      trackProcessor: typeof globalThis.MediaStreamTrackProcessor === "function",
      picker: typeof navigator.mediaDevices?.getDisplayMedia === "function",
      vp8Encode: await test("encode", { codec: "vp8", ...at }),
      avcHardwareEncode: await test("encode", { codec: "avc1.42E02A", ...at, hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } }),
      avcEncode: await test("encode", { codec: "avc1.42E02A", ...at, avc: { format: "annexb" } }),
      vp8Decode: await test("decode", { codec: "vp8" }),
      avcDecode: await test("decode", { codec: "avc1.42E02A" }),
    };
  });
  verdict("WebView2 has WebCodecs, the track processor and the system's picker", has.webCodecs && has.trackProcessor && has.picker, has);
  verdict("WebView2 makes and plays VP8 at 1080p60", has.vp8Encode && has.vp8Decode, has);
  note(`H.264: hardware encode ${has.avcHardwareEncode}, any encode ${has.avcEncode}, decode ${has.avcDecode}`);

  // 1b. The computer's sound (#736): the installed app's shell says this
  // Windows has process loopback, and starts it from the list window, as
  // Share does with the switch on. Then the echo it exists to prevent:
  // Linger plays two tones of its own, which must be left out, 1 kHz from the
  // shell, where voice and chimes play, and 1.4 kHz from the page, which
  // WebView2 plays from a process Linger started; and another program plays
  // 600 Hz, which must be in. The packets are decoded in the page, as a
  // watcher's would be, and each tone's strength read from them.
  const tone = resolve(output, "tone-600.wav");
  await writeFile(tone, toneWav(600, 4));
  await page.evaluate(async () => {
    const tauri = window.__TAURI_INTERNALS__;
    const check = { available: await tauri.invoke("screen_sound_available"), started: null, packets: [] };
    window.__lingerSoundCheck = check;
    const channel = (onMessage) => `__CHANNEL__:${tauri.transformCallback(onMessage)}`;
    const sounds = channel((message) => {
      const body = message?.message ?? message;
      const bytes = body instanceof ArrayBuffer ? body : body?.buffer instanceof ArrayBuffer ? body.buffer : null;
      if (bytes) check.packets.push(bytes);
    });
    const says = channel(() => undefined);
    try {
      await tauri.invoke("screen_sound_start", { sounds, says });
      check.started = "started";
    } catch (error) {
      check.started = String(error);
    }
    // Linger's own sound from the page: WebView2's.
    const context = new AudioContext();
    const own = context.createOscillator();
    const level = context.createGain();
    own.frequency.value = 1400;
    level.gain.value = 0.5;
    own.connect(level).connect(context.destination);
    own.start();
    check.context = context;
    // And from the shell, as a chime plays: two seconds of 1 kHz.
    const chime = Array.from({ length: 96000 }, (_, at) => Math.round(Math.sin((2 * Math.PI * 1000 * at) / 48000) * 16000));
    check.chimed = await tauri.invoke("sound_play", { samples: chime, output: null }).catch((error) => String(error));
  });
  await sleep(500);
  // Another program's sound, not Linger's: Windows' own player.
  const other = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${tone}').PlaySync()`], { encoding: "utf8", timeout: 20000 });
  const sound = await page.evaluate(async () => {
    const check = window.__lingerSoundCheck;
    const tauri = window.__TAURI_INTERNALS__;
    await tauri.invoke("screen_sound_stop").catch(() => undefined);
    await check.context.close().catch(() => undefined);
    // Decoded as a watcher's page would, then each tone's strength (Goertzel).
    const left = [];
    if (check.packets.length > 0 && typeof AudioDecoder === "function") {
      const decoder = new AudioDecoder({
        output: (data) => {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
          left.push(plane);
          data.close();
        },
        error: () => undefined,
      });
      decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
      for (const packet of check.packets) {
        const micros = Number(new DataView(packet).getBigUint64(4));
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: micros, data: new Uint8Array(packet, 12) }));
      }
      await decoder.flush().catch(() => undefined);
      decoder.close();
    }
    const samples = new Float32Array(left.reduce((sum, plane) => sum + plane.length, 0));
    let at = 0;
    for (const plane of left) {
      samples.set(plane, at);
      at += plane.length;
    }
    const strength = (hz) => {
      if (samples.length === 0) return 0;
      const k = 2 * Math.cos((2 * Math.PI * hz) / 48000);
      let [s1, s2] = [0, 0];
      for (const value of samples) [s1, s2] = [value + k * s1 - s2, s1];
      return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2))) / samples.length;
    };
    return { available: check.available, started: check.started, chimed: check.chimed, packets: check.packets.length, seconds: samples.length / 48000, at600: strength(600), at1000: strength(1000), at1400: strength(1400) };
  });
  verdict("the installed app says this Windows can share the computer's sound", sound.available === true, sound);
  verdict("starting the computer's sound answers, started or refused", sound.started === "started" || sound.started === "no-sound", sound);
  if (sound.started === "started" && sound.at600 > 0.02) {
    verdict("another program's sound is in the capture", true, sound);
    // Linger's own tones, far below the other program's: left out.
    verdict("the shell's own sound, where voice and chimes play, is left out of the capture", sound.at1000 < sound.at600 / 30, sound);
    verdict("the page's own sound, played by WebView2, is left out of the capture", sound.at1400 < sound.at600 / 30, sound);
  } else {
    note(`the computer's sound: ${JSON.stringify(sound)}; another program's tone wasn't heard here (${other.status}${other.stderr ? `: ${other.stderr.trim()}` : ""}), so what's left out isn't shown`);
    verdict("Linger's own tones aren't in the capture", sound.at1000 < 0.02 && sound.at1400 < 0.02, sound);
  }

  // 2. Share as Share does: from a press, read through the track processor,
  // encoded as VP8 (and H.264 when the runner makes it), counted. Nothing
  // about what was picked is read.
  await addProbe(page, () => {
    const check = window.__lingerScreenCheck;
    document.getElementById("linger-screen-probe").addEventListener("click", () => {
      navigator.mediaDevices
        .getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false })
        .then(async (stream) => {
          check.status = "sharing";
          const [track] = stream.getVideoTracks();
          const encoders = [];
          const make = async (name, config) => {
            const encoder = new VideoEncoder({
              output: (chunk) => {
                const bucket = check[name];
                bucket.chunks += 1;
                bucket.bytes += chunk.byteLength;
                if (chunk.type === "key") bucket.keys += 1;
              },
              error: (error) => { check.error = `${name}: ${error}`; },
            });
            encoder.configure(config);
            encoders.push(encoder);
          };
          const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
          let n = 0;
          let configured = false;
          while (!check.stop) {
            const { value: frame, done } = await reader.read();
            if (done || !frame) break;
            check.frames += 1;
            if (!configured) {
              configured = true;
              const width = Math.min(1920, frame.displayWidth) & ~1;
              const height = Math.min(1080, frame.displayHeight) & ~1;
              check.size = [width, height];
              const base = { width, height, bitrate: 6_000_000, framerate: 60, latencyMode: "realtime", bitrateMode: "variable" };
              await make("vp8", { codec: "vp8", ...base });
              const avc = { codec: "avc1.42E02A", ...base, hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } };
              if ((await VideoEncoder.isConfigSupported(avc)).supported) await make("avc", avc);
            }
            for (const encoder of encoders) if (encoder.encodeQueueSize <= 2) encoder.encode(frame, { keyFrame: n % 300 === 0 });
            n += 1;
            frame.close();
          }
          for (const encoder of encoders) await encoder.flush().catch(() => undefined);
          for (const each of stream.getTracks()) each.stop();
          check.status = "stopped";
        })
        .catch((error) => {
          check.status = "refused";
          check.error = String(error);
        });
    });
  });
  const started = await statusAfterPress(page);
  verdict("the picker answers a press with a screen", started.status === "sharing", started);

  if (started.status === "sharing") {
    // 3. Three seconds shown, then three minimized: frames keep coming.
    const read = () => page.evaluate(() => ({ frames: window.__lingerScreenCheck.frames, vp8: { ...window.__lingerScreenCheck.vp8 }, avc: { ...window.__lingerScreenCheck.avc }, error: window.__lingerScreenCheck.error, size: window.__lingerScreenCheck.size }));
    // Chromium sends a screen's picture only when the screen changes, and a
    // runner's desktop can sit still for all three seconds (#715): a counter
    // on the page keeps changing while it's shown.
    await page.evaluate(() => {
      const probe = document.getElementById("linger-screen-probe");
      let n = 0;
      window.__lingerScreenTick = window.setInterval(() => {
        n += 1;
        if (probe) probe.textContent = `share ${n}`;
      }, 50);
    });
    const at0 = await read();
    await sleep(3000);
    const shown = await read();
    await win("minimize", { hwnd });
    await sleep(3000);
    const minimized = await read();
    await win("restore", { hwnd });
    await page.evaluate(() => {
      window.clearInterval(window.__lingerScreenTick);
      window.__lingerScreenCheck.stop = true;
    });
    await sleep(1000);
    const end = await read();
    const shownFrames = shown.frames - at0.frames;
    const hiddenFrames = minimized.frames - shown.frames;
    const shownChunks = shown.vp8.chunks - at0.vp8.chunks;
    const hiddenChunks = minimized.vp8.chunks - shown.vp8.chunks;
    verdict("frames come through the track processor and VP8 encodes them", shownFrames > 0 && shownChunks > 0 && end.error === null, { shownFrames, shownChunks, size: end.size, error: end.error });
    verdict("minimized, the share keeps reading and encoding", hiddenFrames > 0 && hiddenChunks > 0, { hiddenFrames, hiddenChunks });
    note(`over 3 s shown: ${shownFrames} frames read, ${shownChunks} VP8 frames (${Math.round((shown.vp8.bytes - at0.vp8.bytes) / 3 / 1000) * 8} kbit/s), H.264 ${shown.avc.chunks - at0.avc.chunks} frames`);
    note("a still screen sends few frames: Chromium delivers a screen's picture when it changes");
  }
} catch (error) {
  verdict("the check ran to the end", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await shutDown();
}

// 4. As a person meets it, without the test switch: the press opens
// WebView2's picker and waits on the person; Escape closes it, and the share
// is refused, which lib/screen/share.ts takes as nothing to say.
try {
  const { page, hwnd } = await launch("", "profile-picker", "app-picker.log");
  await addProbe(page, () => {
    const check = window.__lingerScreenCheck;
    document.getElementById("linger-screen-probe").addEventListener("click", () => {
      navigator.mediaDevices
        .getDisplayMedia({ video: true, audio: false })
        .then((stream) => {
          check.status = "sharing";
          for (const each of stream.getTracks()) each.stop();
        })
        .catch((error) => {
          check.status = "refused";
          check.error = error instanceof DOMException ? error.name : String(error);
        });
    });
  });
  await page.click("#linger-screen-probe");
  await sleep(3000);
  const open = await page.evaluate(() => ({ ...window.__lingerScreenCheck }));
  const picture = await win("capture", { hwnd, path: resolve(output, "picker.png"), how: "screen" });
  verdict("a press opens the picker, which waits on the person", open.status === "waiting", { open, picture: { width: picture.width, height: picture.height } });
  await win("escape");
  let closed = open;
  for (let attempt = 0; attempt < 40 && closed.status === "waiting"; attempt++) {
    await sleep(250);
    closed = await page.evaluate(() => ({ ...window.__lingerScreenCheck }));
  }
  verdict("Escape closes the picker and the share is refused, not left hanging", closed.status === "refused" && (closed.error === "NotAllowedError" || closed.error === "AbortError"), closed);
} catch (error) {
  verdict("the picker check ran to the end", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await shutDown();
  helper.stdin.end();
}

await writeFile(resolve(output, "result.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`FAIL ${failed.length} of ${results.length}: ${failed.map((result) => result.step).join("; ")}`);
  process.exit(1);
}
console.log(`PASS the installed Windows app can share a screen (#360): ${results.length} checks`);
process.exit(0);
