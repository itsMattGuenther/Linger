/**
 * The screen-sharing pipeline on its own (#360): a share and a watch, each
 * on its own screen socket, with no screens around them. The picked screen
 * is a canvas that changes colour, so a test reads the colour that arrived.
 * Browser tests point the sockets at a stand-in for the server
 * (`page.routeWebSocket`); `scripts/screen-loop.mjs` at a real one.
 *
 * `?shell` plays the Linux app's shell (`src-tauri/src/screen_shell.rs`),
 * which captures and encodes the screen itself: Tauri's calls are answered
 * here, and the "shell" sends VP8 frames of the canvas on its channel, as
 * GStreamer would. `loop.shell` says how the next share through it goes.
 *
 * `loop.pane` runs a conversation's screens as the app does
 * (`usePaneScreen`), with the room's voice as `loop.voice` says it.
 *
 * Desktop notices the app raises are kept for `loop.notices` where it plays
 * the Linux app (`?shell`), the only place here the page is an app's: the
 * list window, or with `?label=chat-…` a conversation's own, which asks the
 * list window for one (`loop.shell_asked` has `emit_to <event>`).
 *
 * The computer's sound (#736): with `?shell` the stand-in shell captures
 * "sound" for a share asked to carry it, a packet every 20 ms, and plays a
 * watched share's, counting what it was handed (`loop.sound_played`). The
 * shell's sound is the Windows app's, but the page's part doesn't depend on
 * which desktop it is. Without `?shell` a watcher plays sound in the page,
 * as a phone does, and `loop.feed` can send real Opus for it.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createElement, useEffect, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { VoicePeer } from "../../src/generated/VoicePeer";
import { SharingBox } from "../../src/next/app/screen/SharingBox";
import { usePaneScreen } from "../../src/next/app/screen/usePaneScreen";
import type { ChatPane } from "../../src/next/app/chat/ChatView";
import { AuthedApi, type TokenSource } from "../../src/lib/api";
import { type GatewayState, serverState } from "../../src/lib/gateway";
import { currentShare, currentShareStopped, stopSharing } from "../../src/lib/screen/share";
import { startSharingHere } from "../../src/next/core/screenStop";
import { currentWatch, drawOn, startWatching, stopWatching } from "../../src/lib/screen/watch";
import type { ScreenFps } from "../../src/lib/screen/presets";
import { packFrame, packSound } from "../../src/lib/screen/frames";
import { heard } from "../../src/lib/screen/listen";
import { setWatchSoundOn } from "../../src/lib/screen/sound";
import { screenSilence } from "../../src/lib/screen/socket";
import { people } from "./next/evening";

/** The colour the fake screen shows now, as CSS. */
let colour = "#ff0000";
/** Whether the next fake screen is a busy 1080p one, for a load test. */
let busy = false;

/**
 * A screen to share: a canvas repainted 30 times a second, so frames keep
 * coming. A busy one is 1920×1080 and changes all over every frame, so the
 * encoder spends its whole allowance, the way a video or a game would.
 */
function fakeScreen(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = busy ? 1920 : 640;
  canvas.height = busy ? 1080 : 360;
  const context = canvas.getContext("2d");
  const big = busy;
  let tick = 0;
  const paint = () => {
    tick += 1;
    if (context) {
      context.fillStyle = colour;
      context.fillRect(0, 0, canvas.width, canvas.height);
      // A corner that moves, so no two frames are the same picture.
      context.fillStyle = "#000000";
      context.fillRect(tick % 600, 0, 8, 8);
      for (let block = 0; big && block < 60; block += 1) {
        context.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 80% 50%)`;
        context.fillRect(Math.random() * 1880, Math.random() * 1040, 40 + Math.random() * 160, 40 + Math.random() * 120);
      }
    }
  };
  // A timer, not animation frames: a page in the background (several tests
  // at once) gets no animation frames in WebKit, and its screen would stop.
  paint();
  window.setInterval(paint, big ? 16 : 33);
  return canvas.captureStream(big ? 60 : 30);
}

/**
 * What the picker does next: hands over the fake screen; hands over a
 * screen that never draws a picture ("blank"); or fails with an error of
 * that name, as a closed picker or a computer with no screen portal does.
 */
let picker: string | null = null;

Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
  value: async () => {
    if (picker === "blank") return document.createElement("canvas").captureStream(0);
    if (picker !== null) throw new DOMException("the picker failed", picker);
    return fakeScreen();
  },
  configurable: true,
});

function api(baseUrl: string, token: string): AuthedApi {
  const source: TokenSource = {
    accessToken: token,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: null,
    renew: async () => undefined,
    replace: async () => false,
  };
  return new AuthedApi(baseUrl, source);
}

/**
 * How the stand-in shell answers the next share: frames of the canvas
 * ("ok"); the picker closed ("declined"); nothing it can encode
 * ("no-encoder"); frames, then the screen lost a second in ("fails"); or
 * the picker left open until `loop.pick()` answers it ("waits").
 */
let shellMode = "ok";
/** What the page asked the stand-in shell, in order. */
const shellAsked: string[] = [];
let answerPicker: (() => void) | null = null;

interface Internals {
  runCallback: (id: number, data: unknown) => void;
}

/** A channel the page handed the shell, and how many messages it's had. */
function channelOf(value: unknown): { id: number; sent: number } | null {
  const id: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "id") : null;
  return typeof id === "number" ? { id, sent: 0 } : null;
}

function tell(channel: { id: number; sent: number }, message: unknown): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  internals.runCallback(channel.id, { index: channel.sent, message });
  channel.sent += 1;
}

/** Whether the stand-in shell's preview is on, as the page last said. */
let shellPreview = false;

/** The stand-in shell's share: the canvas, encoded as VP8, on `frames`, and as JPEG on `pictures` while its preview is on. */
function shellShare(fps: number, frames: { id: number; sent: number }, pictures: { id: number; sent: number }, says: { id: number; sent: number }): () => void {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  let key = true;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      tell(frames, packFrame("vp8", chunk.type === "key", chunk.timestamp, bytes));
    },
    error: () => undefined,
  });
  encoder.configure({ codec: "vp8", width: 640, height: 360, bitrate: 2_000_000, framerate: fps, latencyMode: "realtime" });
  let tick = 0;
  const timer = window.setInterval(() => {
    if (!context || encoder.state !== "configured") return;
    tick += 1;
    context.fillStyle = colour;
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#000000";
    context.fillRect(tick % 600, 0, 8, 8);
    const frame = new VideoFrame(canvas, { timestamp: tick * 33_333 });
    encoder.encode(frame, { keyFrame: key });
    key = false;
    frame.close();
  }, 33);
  const keyframe = () => {
    key = true;
  };
  shellKeyframe = keyframe;
  if (shellMode === "fails") window.setTimeout(() => tell(says, { op: "ended", why: "failed" }), 1_000);
  // Looked at once a second, as GStreamer's look does.
  const looks = window.setInterval(() => tell(says, { op: "looks", black: colour === "#000000" }), 1_000);
  const previews = window.setInterval(() => {
    if (!shellPreview) return;
    canvas.toBlob((blob) => void blob?.arrayBuffer().then((bytes) => tell(pictures, bytes)), "image/jpeg");
  }, 250);
  return () => {
    window.clearInterval(timer);
    window.clearInterval(previews);
    window.clearInterval(looks);
    if (encoder.state !== "closed") encoder.close();
  };
}
let shellKeyframe: () => void = () => undefined;
let shellStop: (() => void) | null = null;
/** The stand-in shell's sound for a share: a packet every 20 ms, until stopped. */
let soundTimer = 0;
/** The packets of a watched share's sound the stand-in shell was handed to play. */
let soundPlayed = 0;
/** The desktop notices raised, as Tauri was asked for them. */
const notices: unknown[] = [];

if (new URLSearchParams(location.search).has("shell")) {
  (window as unknown as { isTauri: boolean }).isTauri = true;
  mockWindows(new URLSearchParams(location.search).get("label") ?? "main");
  // Notices allowed, as the app's own permission says on a desktop.
  Object.defineProperty(window, "Notification", { value: { permission: "granted", requestPermission: async () => "granted" }, configurable: true });
  mockIPC(async (command, args) => {
    shellAsked.push(command);
    if (command === "show_notification") notices.push(args);
    if (command === "plugin:event|emit_to" && typeof args === "object" && args !== null) shellAsked.push(`emit_to ${String(Reflect.get(args, "event"))}`);
    if (command === "screen_share_available") return true;
    // `?cpu`: the shell had WebKit draw without the GPU, where building a decoder aborts the page (#729).
    if (command === "screen_watch_available") return !new URLSearchParams(location.search).has("cpu");
    if (command === "screen_share_keyframe") shellKeyframe();
    // What the share encodes, as the page passes on the server's want (#733).
    if (command === "screen_share_want" && typeof args === "object" && args !== null) {
      const codecs: unknown = Reflect.get(args, "codecs");
      shellAsked.push(`want ${Array.isArray(codecs) ? codecs.join(",") : "?"}`);
    }
    if (command === "screen_share_preview") shellPreview = typeof args === "object" && args !== null && Reflect.get(args, "shown") === true;
    if (command === "screen_share_stop") {
      shellStop?.();
      shellStop = null;
    }
    if (command === "screen_sound_available") return true;
    if (command === "screen_sound_play") soundPlayed += 1;
    if (command === "screen_sound_stop") window.clearInterval(soundTimer);
    if (command === "screen_sound_start") {
      const sounds = channelOf(typeof args === "object" && args !== null ? Reflect.get(args, "sounds") : null);
      if (!sounds) throw "no-sound";
      window.clearInterval(soundTimer);
      let at = 0;
      // Not real Opus: the stand-in shell that plays it doesn't decode.
      soundTimer = window.setInterval(() => {
        at += 20_000;
        tell(sounds, packSound(at, new Uint8Array([0xfc, 0xff, 0xfe, at % 251])));
      }, 20);
      return null;
    }
    if (command !== "screen_share_start") return null;
    const given = typeof args === "object" && args !== null ? args : {};
    const frames = channelOf(Reflect.get(given, "frames"));
    const pictures = channelOf(Reflect.get(given, "pictures"));
    shellPreview = Reflect.get(given, "shown") === true;
    const says = channelOf(Reflect.get(given, "says"));
    const fps: unknown = Reflect.get(given, "fps");
    if (shellMode === "waits") await new Promise<void>((answer) => (answerPicker = answer));
    if (shellMode === "declined" || shellMode === "no-encoder") throw shellMode;
    if (!frames || !pictures || !says || typeof fps !== "number") throw "no-screen";
    shellStop = shellShare(fps, frames, pictures, says);
    // `?formats=avc1,vp8`: a shell whose graphics card makes H.264 (#733).
    const formats = new URLSearchParams(location.search).get("formats");
    return formats === null ? null : formats.split(",");
  });
}

const watched = document.getElementById("watched");

/** Your share's box, as the voice bar shows it, for the preview: `loop.box()`. */
function showBox(): void {
  const place = document.createElement("div");
  place.style.width = "320px";
  document.body.append(place);
  const share = currentShare();
  const preview = share?.preview ? { kind: "stream" as const, stream: share.preview } : share?.pictures ? { kind: "pictures" as const } : null;
  createRoot(place).render(createElement(SharingBox, { preview, watching: "", starting: false, onStop: () => stopSharing() }));
}

/**
 * A conversation's screens as the app runs them (`usePaneScreen`), in
 * #general: you in its voice as the session `loop.pane` names, and Jules,
 * sharing or not as `loop.voice` says, the way the server's `voice.state`
 * would. `loop.pane_watch` presses Watch, `loop.pane_close` closes the
 * screen, and `loop.pane_state` reads it. A popped-out one (`loop.pane`'s
 * `own`) draws your share's box as the conversation does, or why it ended.
 */
const ROOM = "r-general";
let paneSession = "";
let voiceNow: VoicePeer[] = [];
const voiceHeard = new Set<() => void>();
let paneNow: ChatPane["screen"] | undefined;

function hearVoice(heard: () => void): () => void {
  voiceHeard.add(heard);
  return () => voiceHeard.delete(heard);
}

function Pane({ baseUrl, token, own }: { baseUrl: string; token: string; own: boolean }) {
  const peers = useSyncExternalStore(hearVoice, () => voiceNow);
  const authed = useMemo(() => api(baseUrl, token), [baseUrl, token]);
  const state = useMemo<GatewayState>(
    () => ({ ...serverState(baseUrl), status: { kind: "ready", latency_ms: 1 }, me: people.matt, users: Object.values(people), sessionId: paneSession, voice: { [ROOM]: peers } }),
    [baseUrl, peers],
  );
  const pane = usePaneScreen({ server: baseUrl, api: authed, state, roomId: ROOM, intend: async () => undefined, screensOn: true, shareBox: own });
  useEffect(() => {
    paneNow = pane;
  }, [pane]);
  // The page's canvas stands in for the screen's.
  useEffect(() => drawOn(watched instanceof HTMLCanvasElement ? watched : null), []);
  if (pane?.box) return createElement(SharingBox, { ...pane.box, layout: "band" });
  return pane?.stopped ? createElement("p", { role: "status", "aria-label": "Why sharing stopped" }, pane.stopped) : null;
}

/** A share made by `loop.feed`, while it runs. */
let fed: { socket: WebSocket; timer: number; encoder: VideoEncoder; hum: AudioEncoder | null; humTimer: number } | null = null;

declare global {
  interface Window {
    loop: {
      share: (baseUrl: string, token: string, sessionId: string, fps: ScreenFps, sound?: boolean) => Promise<void>;
      watch: (baseUrl: string, token: string, sessionId: string, target: string) => Promise<void>;
      paint: (css: string) => void;
      busy: (on: boolean) => void;
      shell: (mode: string) => void;
      shell_asked: () => string[];
      notices: () => unknown[];
      pick: () => void;
      box: () => void;
      picker: (says: string | null) => void;
      stop: () => void;
      share_state: () => unknown;
      share_stopped: () => unknown;
      feed: (baseUrl: string, sessionId: string, sound?: boolean) => void;
      unfeed: () => void;
      pane: (baseUrl: string, sessionId: string, own?: boolean) => void;
      voice: (julesShares: boolean, julesWatches?: string) => void;
      pane_watch: (session: string) => Promise<void>;
      pane_close: () => void;
      pane_state: () => { status: string | null; opensNext: boolean; behind: boolean; sound: { playable: boolean; on: boolean } | null };
      pane_sound: () => void;
      watch_sound: (on: boolean) => void;
      sound_played: () => number;
      silence: (ms: number) => void;
      watch_state: () => unknown;
      pixel: () => number[];
    };
  }
}

window.loop = {
  share: (baseUrl, token, sessionId, fps, sound = false) => startSharingHere({ server: baseUrl, api: api(baseUrl, token), sessionId, fps, sound }),
  watch: async (baseUrl, token, sessionId, target) => {
    await startWatching({ server: baseUrl, api: api(baseUrl, token), sessionId, target, place: "loop", who: "sharer" });
    drawOn(watched instanceof HTMLCanvasElement ? watched : null);
  },
  paint: (css) => {
    colour = css;
  },
  busy: (on) => {
    busy = on;
  },
  shell: (mode) => {
    shellMode = mode;
  },
  shell_asked: () => [...shellAsked],
  notices: () => [...notices],
  pick: () => answerPicker?.(),
  box: showBox,
  picker: (says) => {
    picker = says;
  },
  stop: () => {
    stopSharing();
    stopWatching();
  },
  share_state: () => currentShare(),
  share_stopped: () => currentShareStopped()?.why ?? null,
  // A share made without the screen-reading part: frames drawn on a canvas
  // and encoded here, sent on a share socket. For testing the watching half
  // in an engine whose own sharing isn't tested yet (T-1907).
  feed: (baseUrl, sessionId, sound = false) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/screen`);
    socket.binaryType = "arraybuffer";
    let key = true;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        if (socket.readyState === WebSocket.OPEN) socket.send(packFrame("vp8", chunk.type === "key", chunk.timestamp, bytes));
      },
      error: () => undefined,
    });
    encoder.configure({ codec: "vp8", width: 640, height: 360, bitrate: 2_000_000, framerate: 30, latencyMode: "realtime" });
    let wanted = false;
    let wantsSound = false;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ op: "share", token: "t", session_id: sessionId, fps: 30, encode: ["vp8"], ...(sound ? { sound: true } : {}) })));
    socket.addEventListener("message", (event) => {
      const said = JSON.parse(String(event.data)) as { op: string; codecs?: string[]; sound?: boolean };
      if (said.op === "want") {
        wanted = (said.codecs ?? []).includes("vp8");
        wantsSound = said.sound === true;
      }
      if (said.op === "keyframe") key = true;
    });
    // The computer's sound, as real Opus, the way the Windows app's shell
    // sends it: a tone, 20 ms at a time, while somebody watching wants it.
    let hum: AudioEncoder | null = null;
    let humTimer = 0;
    if (sound && typeof AudioEncoder === "function") {
      const made = new AudioEncoder({
        output: (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          if (wantsSound && socket.readyState === WebSocket.OPEN) socket.send(packSound(chunk.timestamp, bytes));
        },
        error: () => undefined,
      });
      made.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 });
      hum = made;
      let frame = 0;
      humTimer = window.setInterval(() => {
        if (made.state !== "configured") return;
        const samples = new Float32Array(960 * 2);
        for (let at = 0; at < 960; at += 1) {
          const value = Math.sin(((frame * 960 + at) / 48_000) * 440 * 2 * Math.PI) * 0.2;
          samples[at] = value;
          samples[960 + at] = value;
        }
        made.encode(new AudioData({ format: "f32-planar", sampleRate: 48_000, numberOfFrames: 960, numberOfChannels: 2, timestamp: frame * 20_000, data: samples }));
        frame += 1;
      }, 20);
    }
    let tick = 0;
    const timer = window.setInterval(() => {
      if (!context || !wanted) return;
      tick += 1;
      context.fillStyle = colour;
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#000000";
      context.fillRect(tick % 600, 0, 8, 8);
      const frame = new VideoFrame(canvas, { timestamp: tick * 33_333 });
      encoder.encode(frame, { keyFrame: key });
      key = false;
      frame.close();
    }, 33);
    fed = { socket, timer, encoder, hum, humTimer };
  },
  // The fed share stops, as Stop does: its socket closes.
  unfeed: () => {
    if (!fed) return;
    window.clearInterval(fed.timer);
    window.clearInterval(fed.humTimer);
    fed.socket.close(1000);
    if (fed.encoder.state !== "closed") fed.encoder.close();
    if (fed.hum && fed.hum.state !== "closed") fed.hum.close();
    fed = null;
  },
  pane: (baseUrl, sessionId, own = false) => {
    paneSession = sessionId;
    const place = document.createElement("div");
    document.body.append(place);
    createRoot(place).render(createElement(Pane, { baseUrl, token: "token", own }));
  },
  voice: (julesShares, julesWatches) => {
    voiceNow = [
      { session_id: paneSession, user_id: people.matt.id },
      { session_id: "s-jules", user_id: people.jules.id, ...(julesShares ? { screen: { fps: 30 as const } } : {}), ...(julesWatches ? { watching: julesWatches } : {}) },
    ];
    for (const heard of voiceHeard) heard();
  },
  // Pressed once the voice line offers it: the pane draws after `pane` and
  // `voice` return, and a Watch pressed before that pressed nothing, which a
  // busy WebKit on CI once showed (#736).
  pane_watch: async (session) => {
    for (let wait = 0; wait < 100 && !paneNow?.watch?.sharers.some((one) => one.session === session); wait += 1) {
      await new Promise((settle) => window.setTimeout(settle, 50));
    }
    paneNow?.watch?.onWatch(session);
  },
  pane_close: () => paneNow?.stage?.onClose(),
  pane_state: () => ({
    status: paneNow?.stage?.status ?? null,
    opensNext: paneNow?.stage?.opensNext ?? false,
    behind: paneNow?.stage?.behind ?? false,
    sound: paneNow?.stage?.sound ? { playable: paneNow.stage.sound.playable, on: paneNow.stage.sound.on } : null,
  }),
  // The screen's sound button, pressed (#736).
  pane_sound: () => paneNow?.stage?.sound?.onToggle(),
  watch_sound: (on) => setWatchSoundOn(on),
  // What was played: by the stand-in shell (`?shell`), or by the page.
  sound_played: () => (new URLSearchParams(location.search).has("shell") ? soundPlayed : heard.played),
  silence: (ms) => {
    screenSilence.ms = ms;
  },
  watch_state: () => currentWatch(),
  pixel: () => {
    if (!(watched instanceof HTMLCanvasElement)) return [];
    const context = watched.getContext("2d");
    const x = Math.floor(watched.width / 2);
    const y = Math.floor(watched.height / 2);
    return context ? [...context.getImageData(x, y, 1, 1).data] : [];
  },
};
