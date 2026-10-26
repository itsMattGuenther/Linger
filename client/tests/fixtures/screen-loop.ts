/**
 * The screen-sharing pipeline on its own (#360): a share and a watch, each
 * on its own screen socket, with no screens around them. The picked screen
 * is a canvas that changes colour, so a test reads the colour that arrived.
 * Browser tests point the sockets at a stand-in for the server
 * (`page.routeWebSocket`); `scripts/screen-loop.mjs` at a real one.
 */
import { AuthedApi, type TokenSource } from "../../src/lib/api";
import { currentShare, currentShareStopped, startSharing, stopSharing } from "../../src/lib/screen/share";
import { currentWatch, drawOn, startWatching, stopWatching } from "../../src/lib/screen/watch";
import type { ScreenFps } from "../../src/lib/screen/presets";
import { packFrame } from "../../src/lib/screen/frames";

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

const watched = document.getElementById("watched");

declare global {
  interface Window {
    loop: {
      share: (baseUrl: string, token: string, sessionId: string, fps: ScreenFps) => Promise<void>;
      watch: (baseUrl: string, token: string, sessionId: string, target: string) => Promise<void>;
      paint: (css: string) => void;
      busy: (on: boolean) => void;
      picker: (says: string | null) => void;
      stop: () => void;
      share_state: () => unknown;
      share_stopped: () => unknown;
      feed: (baseUrl: string, sessionId: string) => void;
      watch_state: () => unknown;
      pixel: () => number[];
    };
  }
}

window.loop = {
  share: (baseUrl, token, sessionId, fps) => startSharing({ server: baseUrl, api: api(baseUrl, token), sessionId, fps }),
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
  feed: (baseUrl, sessionId) => {
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
    socket.addEventListener("open", () => socket.send(JSON.stringify({ op: "share", token: "t", session_id: sessionId, fps: 30, encode: ["vp8"] })));
    socket.addEventListener("message", (event) => {
      const said = JSON.parse(String(event.data)) as { op: string; codecs?: string[] };
      if (said.op === "want") wanted = (said.codecs ?? []).includes("vp8");
      if (said.op === "keyframe") key = true;
    });
    let tick = 0;
    window.setInterval(() => {
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
