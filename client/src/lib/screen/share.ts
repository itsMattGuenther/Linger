import { useSyncExternalStore } from "react";
import type { ScreenCodec } from "../../generated/ScreenCodec";
import type { AuthedApi } from "../api";
import { packFrame } from "./frames";
import { encoderConfig, fitWithin, KEYFRAME_EVERY_MS, SCREEN_SPEEDS, type ScreenFps, type ScreenSpeed } from "./presets";
import { canPickScreen, makeable } from "./probe";
import { closingOf, openScreenSocket, readSaid, RETRIES, retryAfter, type ScreenClosing } from "./socket";

/**
 * Sharing your screen (SPEC §4.20, PROTOCOL §8, #360), in the window where
 * Share was pressed. The system's own picker chooses what to share; this
 * code never asks the picture what it is (hard rule 2), only turns it into
 * the formats the server asks for and sends them on the screen socket.
 *
 * One share at a time, from this window. What everybody sees about it comes
 * from `voice.state`, the server's word; this is the window's own end.
 */

/** Why a share ended when it wasn't Stop. */
export type ShareStopped = ScreenClosing | "no-picker" | "no-encoder";

export interface ScreenShareState {
  server: string;
  fps: ScreenFps;
  /** Asking the system, connecting, or sending. */
  status: "picking" | "starting" | "sharing";
  /** What everybody sees, for your own small copy of it. */
  preview: MediaStream | null;
}

/** The share as this window holds it, or null. */
let shown: ScreenShareState | null = null;
/** Why the last share ended by itself, until another starts or it's cleared. */
let lastStop: { server: string; why: ShareStopped } | null = null;
const listeners = new Set<() => void>();

function publish(next: ScreenShareState | null): void {
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The share this window is making, for its screens. */
export function useScreenShare(): ScreenShareState | null {
  return useSyncExternalStore(subscribe, () => shown);
}

/** The share this window is making, outside React (tests, the tray). */
export function currentShare(): ScreenShareState | null {
  return shown;
}

/** Why the last share ended by itself, if it did. */
export function useShareStopped(): { server: string; why: ShareStopped } | null {
  return useSyncExternalStore(subscribe, () => lastStop);
}

export function clearShareStopped(): void {
  lastStop = null;
  for (const listener of listeners) listener();
}

/** The share running in this window. */
let running: Sharing | null = null;

/**
 * Share your screen on `server` at `fps`. Call it straight from the click:
 * the system's picker opens only from a person's own press, and some engines
 * forget a press across any wait. Resolves once the picker has answered;
 * closing the picker shares nothing and says nothing.
 */
export async function startSharing(options: { server: string; api: AuthedApi; sessionId: string; fps: ScreenFps }): Promise<void> {
  running?.finish(null);
  lastStop = null;
  if (!canPickScreen()) {
    lastStop = { server: options.server, why: "no-picker" };
    publish(null);
    return;
  }
  const speed = SCREEN_SPEEDS[options.fps];
  // Asked before anything is awaited, inside the press (see above).
  const picking = navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: speed.fps, max: speed.fps }, width: { max: speed.maxWidth }, height: { max: speed.maxHeight } },
    audio: false,
  });
  publish({ server: options.server, fps: options.fps, status: "picking", preview: null });
  let stream: MediaStream;
  try {
    stream = await picking;
  } catch {
    // The picker was closed, or the system said no: nothing to say.
    publish(null);
    return;
  }
  const track = stream.getVideoTracks()[0];
  const made = await makeable(options.fps);
  if (!track || made.codecs.length === 0) {
    for (const each of stream.getTracks()) each.stop();
    lastStop = { server: options.server, why: "no-encoder" };
    publish(null);
    return;
  }
  track.contentHint = speed.hint === "detail" ? "detail" : "motion";
  const sharing = new Sharing(options.server, options.api, options.sessionId, speed, stream, track, made.codecs, made.hardware);
  running = sharing;
  publish({ server: options.server, fps: options.fps, status: "starting", preview: stream });
  sharing.start();
}

/** Stop sharing, from Stop or the tray. */
export function stopSharing(): void {
  running?.finish(null);
}

/** Whether this window is sharing on `server`. */
export function sharingOn(server: string): boolean {
  return running !== null && shown?.server === server;
}

/** How much may wait in the socket before frames are skipped: about two seconds at 6 Mbit/s. */
const MOST_WAITING = 1_500_000;
/** How many frames may wait in an encoder before frames are skipped: the computer is behind. */
const MOST_ENCODING = 2;
/** An encoder that fails this many times in this long is given up on. */
const FAILS = 3;
const FAILS_WITHIN_MS = 10_000;

interface Encoder {
  encoder: VideoEncoder;
  width: number;
  height: number;
  keyAt: number;
  wantKey: boolean;
}

/** The track processor, where the engine has one (Chromium, the iPhone's WebKit). */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
type TrackProcessorClass = new (init: { track: MediaStreamTrack }) => TrackProcessor;

function trackProcessor(): TrackProcessorClass | null {
  const found: unknown = Reflect.get(globalThis, "MediaStreamTrackProcessor");
  return typeof found === "function" ? (found as TrackProcessorClass) : null;
}

class Sharing {
  #socket: WebSocket | null = null;
  #attempts = 0;
  #encoders = new Map<ScreenCodec, Encoder>();
  #wanted: ScreenCodec[] = [];
  #latest: VideoFrame | null = null;
  #lastFrameAt = Number.NEGATIVE_INFINITY;
  #fails = new Map<ScreenCodec, number[]>();
  #done = false;
  #stopReading: (() => void) | null = null;

  constructor(
    readonly server: string,
    readonly api: AuthedApi,
    readonly sessionId: string,
    readonly speed: ScreenSpeed,
    readonly stream: MediaStream,
    readonly track: MediaStreamTrack,
    public codecs: ScreenCodec[],
    readonly hardware: ReadonlySet<ScreenCodec>,
  ) {}

  start(): void {
    // The system's own "Stop sharing" ends it as Stop does.
    this.track.addEventListener("ended", () => this.finish(null), { once: true });
    void this.connect();
    this.read();
  }

  async connect(): Promise<void> {
    if (this.#done) return;
    let token: string;
    try {
      token = (await this.api.accessToken()).token;
    } catch {
      this.finish("not-signed-in");
      return;
    }
    if (this.#done) return;
    const socket = openScreenSocket(this.api.baseUrl, {
      op: "share",
      token,
      session_id: this.sessionId,
      fps: this.speed.fps,
      encode: this.codecs,
    });
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket) this.said(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket || this.#done) return;
      this.#socket = null;
      const why = closingOf(event.code);
      if (why === "dropped" && this.#attempts < RETRIES) {
        const wait = retryAfter(this.#attempts);
        this.#attempts += 1;
        window.setTimeout(() => void this.connect(), wait);
        return;
      }
      this.finish(why === "replaced" ? null : why);
    });
  }

  said(data: unknown): void {
    const said = readSaid(data);
    if (!said) return;
    if (said.op === "want" && Array.isArray(said.codecs)) {
      this.#attempts = 0;
      const asked: unknown[] = said.codecs;
      const wanted = asked.filter((codec): codec is ScreenCodec => codec === "vp8" || codec === "avc1");
      for (const [codec, held] of this.#encoders) {
        if (!wanted.includes(codec)) {
          closeEncoder(held);
          this.#encoders.delete(codec);
        }
      }
      this.#wanted = wanted;
      if (shown?.status !== "sharing" && shown?.server === this.server) publish({ ...shown, status: "sharing" });
      // Somebody new is watching: they needn't wait for the screen to change.
      if (this.#latest) for (const codec of wanted) this.encode(codec, this.#latest, true);
    } else if (said.op === "keyframe" && (said.codec === "vp8" || said.codec === "avc1")) {
      const held = this.#encoders.get(said.codec);
      if (held) held.wantKey = true;
      // A screen that isn't changing sends no frames, so the last one is sent again as a key frame.
      if (this.#latest && this.#wanted.includes(said.codec)) this.encode(said.codec, this.#latest, true);
    }
  }

  /** Take frames from the track as they come. */
  read(): void {
    const Processor = trackProcessor();
    if (Processor) {
      const reader = new Processor({ track: this.track }).readable.getReader();
      this.#stopReading = () => void reader.cancel().catch(() => undefined);
      const pump = async () => {
        while (!this.#done) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done || !value) break;
          this.frame(value);
        }
      };
      void pump();
      return;
    }
    // An engine without a track processor: the track plays in a video that
    // nobody sees, and each new picture it shows is a frame.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    this.#stopReading = () => {
      video.pause();
      video.srcObject = null;
    };
    const tick = () => {
      if (this.#done) return;
      try {
        this.frame(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1_000) }));
      } catch {
        // Not a picture yet.
      }
      video.requestVideoFrameCallback(tick);
    };
    void video.play().then(() => video.requestVideoFrameCallback(tick)).catch(() => this.finish("dropped"));
  }

  frame(frame: VideoFrame): void {
    const now = performance.now();
    // No faster than the speed it was started at.
    if (this.#done || now - this.#lastFrameAt < 800 / this.speed.fps) {
      frame.close();
      return;
    }
    this.#lastFrameAt = now;
    this.#latest?.close();
    this.#latest = frame.clone();
    for (const codec of this.#wanted) this.encode(codec, frame, false);
    frame.close();
  }

  encode(codec: ScreenCodec, frame: VideoFrame, forceKey: boolean): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // The line to the server is behind: skip this frame rather than queue it.
    if (socket.bufferedAmount > MOST_WAITING) {
      const held = this.#encoders.get(codec);
      if (held) held.wantKey = true;
      return;
    }
    const size = fitWithin(frame.displayWidth, frame.displayHeight, this.speed.maxWidth, this.speed.maxHeight);
    let held = this.#encoders.get(codec);
    if (!held || held.width !== size.width || held.height !== size.height) {
      if (held) closeEncoder(held);
      const opened = this.openEncoder(codec, size.width, size.height);
      if (!opened) return;
      this.#encoders.set(codec, opened);
      held = opened;
    }
    if (held.encoder.encodeQueueSize > MOST_ENCODING) {
      held.wantKey = true;
      return;
    }
    const now = performance.now();
    const key = forceKey || held.wantKey || now - held.keyAt > KEYFRAME_EVERY_MS;
    try {
      held.encoder.encode(frame, { keyFrame: key });
      if (key) {
        held.wantKey = false;
        held.keyAt = now;
      }
    } catch {
      this.failed(codec);
    }
  }

  openEncoder(codec: ScreenCodec, width: number, height: number): Encoder | null {
    try {
      const encoder = new VideoEncoder({
        output: (chunk) => this.send(codec, chunk),
        error: () => this.failed(codec),
      });
      encoder.configure(encoderConfig(codec, this.speed, width, height, this.hardware.has(codec)));
      return { encoder, width, height, keyAt: Number.NEGATIVE_INFINITY, wantKey: true };
    } catch {
      this.failed(codec);
      return null;
    }
  }

  send(codec: ScreenCodec, chunk: EncodedVideoChunk): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.#wanted.includes(codec)) return;
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    socket.send(packFrame(codec, chunk.type === "key", chunk.timestamp, bytes));
  }

  /**
   * An encoder broke. It is made again on the next frame; one that keeps
   * breaking is given up on, and the server told this app can't make that
   * format after all, so it picks again for everybody watching.
   */
  failed(codec: ScreenCodec): void {
    const held = this.#encoders.get(codec);
    if (held) closeEncoder(held);
    this.#encoders.delete(codec);
    const now = performance.now();
    const recent = [...(this.#fails.get(codec) ?? []), now].filter((at) => now - at < FAILS_WITHIN_MS);
    this.#fails.set(codec, recent);
    if (recent.length < FAILS || this.#done) return;
    this.#fails.delete(codec);
    this.codecs = this.codecs.filter((one) => one !== codec);
    if (this.codecs.length === 0) {
      this.finish("no-encoder");
      return;
    }
    // A new hello with what's left: the server takes it as sharing again.
    const old = this.#socket;
    this.#socket = null;
    old?.close(1000);
    this.#wanted = [];
    void this.connect();
  }

  /** End it: `why` is null for Stop, a reason otherwise. */
  finish(why: ShareStopped | null): void {
    if (this.#done) return;
    this.#done = true;
    this.#stopReading?.();
    for (const held of this.#encoders.values()) closeEncoder(held);
    this.#encoders.clear();
    this.#latest?.close();
    this.#latest = null;
    for (const each of this.stream.getTracks()) each.stop();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    if (running === this) running = null;
    if (why !== null && why !== "ended") lastStop = { server: this.server, why };
    if (shown?.server === this.server) publish(null);
    else for (const listener of listeners) listener();
  }
}

function closeEncoder(held: Encoder): void {
  try {
    if (held.encoder.state !== "closed") held.encoder.close();
  } catch {
    // Already gone.
  }
}
