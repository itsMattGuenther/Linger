import { useSyncExternalStore } from "react";
import type { ScreenCodec } from "../../generated/ScreenCodec";
import type { AuthedApi } from "../api";
import { BlackWatch, LOOK_EVERY_MS, LOOK_HEIGHT, LOOK_WIDTH, looksBlack } from "./black";
import { MAX_FRAME_BYTES, packFrame, readFrame } from "./frames";
import { encoderConfig, fitWithin, KEYFRAME_EVERY_MS, SCREEN_SPEEDS, type ScreenFps, type ScreenSpeed } from "./presets";
import { canPickScreen, makeable } from "./probe";
import { captureInShell, sharesThroughShell, type ShellCapture } from "./shell";
import { closingOf, onSilence, openScreenSocket, readSaid, RETRIES, retryAfter, type ScreenClosing } from "./socket";

/**
 * Sharing your screen (SPEC §4.20, PROTOCOL §8, #360), in the window where
 * Share was pressed. The system's own picker chooses what to share; this
 * code never asks the picture what it is (hard rule 2), only turns it into
 * the formats the server asks for and sends them on the screen socket.
 *
 * One share at a time, from this window. What everybody sees about it comes
 * from `voice.state`, the server's word; this is the window's own end.
 *
 * Where the pictures come from depends on the app: the page's own track,
 * encoded here with WebCodecs (Windows), or the desktop shell, which picks,
 * reads and encodes the screen itself and hands over finished frames (Linux,
 * `shell.ts`). The socket, the watchers and the endings are the same.
 */

/** Why a share ended when it wasn't Stop. */
export type ShareStopped = ScreenClosing | "no-picker" | "no-encoder" | "no-screen" | "no-frames";

export interface ScreenShareState {
  server: string;
  fps: ScreenFps;
  /** Asking the system, connecting, or sending. */
  status: "picking" | "starting" | "sharing";
  /** What everybody sees, for your own copy of it (the page's own share). */
  preview: MediaStream | null;
  /** The shell's preview pictures come instead (`onPreviewPicture`, Linux). */
  pictures: boolean;
  /** It went black for a while: a slide show in a window of its own, if one window was shared (`black.ts`). */
  wentBlack: boolean;
}

/** The share as this window holds it, or null. */
let shown: ScreenShareState | null = null;
/** Why the last share ended by itself, until another starts or it's been said a while. */
let lastStop: { server: string; why: ShareStopped } | null = null;
/** How long the voice bar says why a share ended by itself. */
const STOPPED_SAID_MS = 15_000;
let stopTimer = 0;

function stopped(server: string, why: ShareStopped): void {
  lastStop = { server, why };
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    lastStop = null;
    for (const listener of listeners) listener();
  }, STOPPED_SAID_MS);
}
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

/** Why the last share ended by itself, outside React (tests). */
export function currentShareStopped(): { server: string; why: ShareStopped } | null {
  return lastStop;
}

export function clearShareStopped(): void {
  lastStop = null;
  for (const listener of listeners) listener();
}

/**
 * Whether your share's preview is shown, on this computer, for every share
 * from now on: hidden, the page's preview stops playing and the shell's
 * stops being made, which is less for the computer to do (#360).
 */
const PREVIEW_KEY = "linger.next.sharePreview";
let previewShown = readPreviewShown();
const previewListeners = new Set<() => void>();

function readPreviewShown(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Whether your share's preview is shown. */
export function usePreviewShown(): boolean {
  return useSyncExternalStore(subscribePreview, () => previewShown);
}

function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

/** Show your share's preview, or hide it; kept for next time. */
export function setPreviewShown(shown: boolean): void {
  previewShown = shown;
  try {
    if (shown) localStorage.removeItem(PREVIEW_KEY);
    else localStorage.setItem(PREVIEW_KEY, "hidden");
  } catch {
    // Not kept; it still holds until the app closes.
  }
  if (running?.source.kind === "shell") running.source.capture.preview(shown);
  for (const listener of previewListeners) listener();
}

const blackListeners = new Set<() => void>();

/**
 * Told once a share has gone black (`black.ts`), for the desktop notice:
 * only the list window may raise one, so a share from a conversation's own
 * window asks it to (`core/screenStop.ts`).
 */
export function onShareWentBlack(listener: () => void): () => void {
  blackListeners.add(listener);
  return () => blackListeners.delete(listener);
}

const pictureListeners = new Set<(picture: ArrayBuffer) => void>();

/** Each of the shell's preview pictures (JPEG) as it comes, while the preview is shown. */
export function onPreviewPicture(listener: (picture: ArrayBuffer) => void): () => void {
  pictureListeners.add(listener);
  return () => pictureListeners.delete(listener);
}

/** The share running in this window. */
let running: Sharing | null = null;
/** The picker this window has open, until it answers; Stop forgets it. */
let picking: object | null = null;

/**
 * Share your screen on `server` at `fps`. Call it straight from the click:
 * the system's picker opens only from a person's own press, and some engines
 * forget a press across any wait. Resolves once the picker has answered;
 * closing the picker shares nothing and says nothing.
 */
export async function startSharing(options: { server: string; api: AuthedApi; sessionId: string; fps: ScreenFps }): Promise<void> {
  running?.finish(null);
  lastStop = null;
  const ask = {};
  picking = ask;
  if (sharesThroughShell()) {
    await startInShell(options, ask);
    return;
  }
  if (!canPickScreen()) {
    stopped(options.server, "no-picker");
    publish(null);
    return;
  }
  const speed = SCREEN_SPEEDS[options.fps];
  // Asked before anything is awaited, inside the press (see above).
  const asked = navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: speed.fps, max: speed.fps }, width: { max: speed.maxWidth }, height: { max: speed.maxHeight } },
    audio: false,
  });
  publish({ server: options.server, fps: options.fps, status: "picking", preview: null, pictures: false, wentBlack: false });
  let stream: MediaStream;
  try {
    stream = await asked;
  } catch (error) {
    if (picking !== ask) return;
    picking = null;
    publish(null);
    // Closed, or turned down by the person: nothing to say. Anything else
    // is the computer failing to hand a screen over (on Linux, no screen
    // portal or no PipeWire for it), which is said.
    const declined = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
    if (!declined) stopped(options.server, "no-screen");
    return;
  }
  const track = stream.getVideoTracks()[0];
  const made = await makeable(options.fps);
  if (picking !== ask) {
    // Stopped while the picker was open.
    for (const each of stream.getTracks()) each.stop();
    return;
  }
  picking = null;
  if (!track || made.codecs.length === 0) {
    for (const each of stream.getTracks()) each.stop();
    stopped(options.server, "no-encoder");
    publish(null);
    return;
  }
  track.contentHint = speed.hint === "detail" ? "detail" : "motion";
  const sharing = new Sharing(options.server, options.api, options.sessionId, speed, { kind: "track", stream, track }, made.codecs, made.hardware);
  running = sharing;
  publish({ server: options.server, fps: options.fps, status: "starting", preview: stream, pictures: false, wentBlack: false });
  sharing.start();
}

/**
 * Share through the desktop shell (Linux): its picker is the desktop's own
 * too, opened by the shell, so nothing here waits on the press. It sends
 * VP8 only, as the page does where the graphics card makes no H.264.
 */
async function startInShell(options: { server: string; api: AuthedApi; sessionId: string; fps: ScreenFps }, ask: object): Promise<void> {
  publish({ server: options.server, fps: options.fps, status: "picking", preview: null, pictures: false, wentBlack: false });
  const capture = await captureInShell(options.fps, previewShown);
  if (picking !== ask) {
    if (typeof capture !== "string") capture.stop();
    return;
  }
  picking = null;
  if (typeof capture === "string") {
    publish(null);
    if (capture !== "declined") stopped(options.server, capture);
    return;
  }
  const sharing = new Sharing(options.server, options.api, options.sessionId, SCREEN_SPEEDS[options.fps], { kind: "shell", capture }, ["vp8"], new Set());
  running = sharing;
  publish({ server: options.server, fps: options.fps, status: "starting", preview: null, pictures: true, wentBlack: false });
  sharing.start();
}

/** Stop sharing, from Stop or the tray; a picker still open is forgotten. */
export function stopSharing(): void {
  if (picking !== null) {
    picking = null;
    if (shown?.status === "picking") publish(null);
  }
  running?.finish(null);
}

/** Whether this window is sharing on `server`. */
export function sharingOn(server: string): boolean {
  return running !== null && shown?.server === server;
}

/**
 * How long a share waits for the screen's first picture before it stops and
 * says so: an engine that hands over a screen but no pictures of it (a
 * desktop whose screen portal and web engine don't agree) would otherwise
 * say "Sharing your screen" with nothing going out.
 */
const FIRST_FRAME_MS = 8_000;

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

/**
 * Where a share's pictures come from: the page's own track, encoded here,
 * or the desktop shell's frames, encoded there.
 */
type Source = { kind: "track"; stream: MediaStream; track: MediaStreamTrack } | { kind: "shell"; capture: ShellCapture };

class Sharing {
  #socket: WebSocket | null = null;
  #attempts = 0;
  #encoders = new Map<ScreenCodec, Encoder>();
  #wanted: ScreenCodec[] = [];
  #latest: VideoFrame | null = null;
  #lastFrameAt = Number.NEGATIVE_INFINITY;
  #fails = new Map<ScreenCodec, number[]>();
  #done = false;
  #seen = false;
  #firstFrameTimer = 0;
  #stopReading: (() => void) | null = null;
  /** The shell's frames go out from a key frame on, after one is skipped. */
  #shellWaitsForKey = true;
  /** Looked at for whether it has gone black (`black.ts`). */
  #black = new BlackWatch();
  #lookTimer = 0;
  /** The picture last looked at, and whether it was black: a screen that isn't changing sends no new ones. */
  #looked: { frame: VideoFrame; black: boolean } | null = null;
  #look: OffscreenCanvas | null = null;

  constructor(
    readonly server: string,
    readonly api: AuthedApi,
    readonly sessionId: string,
    readonly speed: ScreenSpeed,
    readonly source: Source,
    public codecs: ScreenCodec[],
    readonly hardware: ReadonlySet<ScreenCodec>,
  ) {}

  start(): void {
    this.#firstFrameTimer = window.setTimeout(() => {
      if (!this.#seen) this.finish("no-frames");
    }, FIRST_FRAME_MS);
    const source = this.source;
    if (source.kind === "shell") {
      source.capture.onFrame = (frame) => this.shellFrame(frame);
      source.capture.onPicture = (picture) => {
        if (!this.#done) for (const listener of pictureListeners) listener(picture);
      };
      // The screen went (a shared window closed), or the shell couldn't read it.
      source.capture.onEnded = (why) => this.finish(why === "gone" ? null : "no-frames");
      // The shell looks at the share itself, and says what it saw.
      source.capture.onLooked = (black) => this.looked(black);
      this.#stopReading = () => source.capture.stop();
      void this.connect();
      return;
    }
    // The system's own "Stop sharing" ends it as Stop does.
    source.track.addEventListener("ended", () => this.finish(null), { once: true });
    void this.connect();
    this.read(source.track);
    this.#lookTimer = window.setInterval(() => this.lookAtLatest(), LOOK_EVERY_MS);
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
    socket.addEventListener("close", (event) => this.closed(socket, event.code));
    // Nothing from the server, not even its `alive`: the line died without
    // closing, and this is a drop like any other.
    onSilence(socket, () => {
      this.closed(socket, 1006);
      socket.close();
    });
  }

  /** `socket` closed with `code`, or went silent: try again after a drop, or end. */
  closed(socket: WebSocket, code: number): void {
    if (this.#socket !== socket || this.#done) return;
    this.#socket = null;
    const why = closingOf(code);
    if (why === "dropped" && this.#attempts < RETRIES) {
      const wait = retryAfter(this.#attempts);
      this.#attempts += 1;
      window.setTimeout(() => void this.connect(), wait);
      return;
    }
    // Back after a drop to a server that has no seat for this session (a
    // restart forgets them all): the connection is what went, so say so.
    const lost = this.#attempts > 0 && (why === "not-in-voice" || why === "ended");
    this.finish(why === "replaced" ? null : lost ? "dropped" : why);
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
      if (this.source.kind === "shell") {
        if (wanted.length > 0) this.source.capture.keyframe();
      } else if (this.#latest) for (const codec of wanted) this.encode(codec, this.#latest, true);
    } else if (said.op === "keyframe" && (said.codec === "vp8" || said.codec === "avc1")) {
      if (this.source.kind === "shell") {
        this.source.capture.keyframe();
        return;
      }
      const held = this.#encoders.get(said.codec);
      if (held) held.wantKey = true;
      // A screen that isn't changing sends no frames, so the last one is sent again as a key frame.
      if (this.#latest && this.#wanted.includes(said.codec)) this.encode(said.codec, this.#latest, true);
    }
  }

  /**
   * A frame from the shell, already encoded and in the socket's shape. One
   * skipped (the line to the server behind) leaves the frames after it
   * nothing to build on, so they wait for the next key frame, asked for now.
   */
  shellFrame(frame: ArrayBuffer): void {
    const read = readFrame(frame);
    if (!read || this.#done) return;
    this.#seen = true;
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.#wanted.includes(read.codec)) return;
    if (this.#shellWaitsForKey && !read.key) return;
    // Bigger than the server passes on: not sent, and the next a key frame.
    if (frame.byteLength > MAX_FRAME_BYTES) {
      this.#shellWaitsForKey = true;
      if (this.source.kind === "shell") this.source.capture.keyframe();
      return;
    }
    if (socket.bufferedAmount > MOST_WAITING) {
      this.#shellWaitsForKey = true;
      if (this.source.kind === "shell") this.source.capture.keyframe();
      return;
    }
    this.#shellWaitsForKey = false;
    socket.send(frame);
  }

  /**
   * Look at the newest picture for whether it's black, about once a
   * second: a small copy, here, read only for that (`black.ts`). The same
   * picture as last time is the same answer.
   */
  lookAtLatest(): void {
    const frame = this.#latest;
    if (!frame || this.#done) return;
    if (this.#looked?.frame !== frame) this.#looked = { frame, black: this.blackIn(frame) };
    this.looked(this.#looked.black);
  }

  blackIn(frame: VideoFrame): boolean {
    try {
      this.#look ??= new OffscreenCanvas(LOOK_WIDTH, LOOK_HEIGHT);
      const context = this.#look.getContext("2d");
      if (!context) return false;
      context.clearRect(0, 0, LOOK_WIDTH, LOOK_HEIGHT);
      context.drawImage(frame, 0, 0, LOOK_WIDTH, LOOK_HEIGHT);
      return looksBlack(context.getImageData(0, 0, LOOK_WIDTH, LOOK_HEIGHT).data, 4);
    } catch {
      // An engine that can't draw a frame: nothing is said.
      return false;
    }
  }

  /** What a look saw: black long enough, the box says so from now on, and a desktop notice says it once. */
  looked(black: boolean): void {
    if (this.#done || running !== this || !this.#black.look(performance.now(), black)) return;
    if (shown?.server === this.server) publish({ ...shown, wentBlack: true });
    for (const listener of blackListeners) listener();
  }

  /** Take frames from the track as they come. */
  read(track: MediaStreamTrack): void {
    const Processor = trackProcessor();
    if (Processor) {
      const reader = new Processor({ track }).readable.getReader();
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
    this.readFromVideo(track);
  }

  /**
   * An engine with no track processor (none Share is offered in yet): the
   * track plays in a video nobody sees, and its picture is taken at the
   * share's speed. The video is in the page, out of sight, since an engine
   * may not play one that isn't; a screen that isn't changing is the same
   * picture again, which costs next to nothing to send. A page out of sight
   * may stop playing it, so this is the last way, not the first.
   */
  readFromVideo(track: MediaStreamTrack): void {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    Object.assign(video.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    video.srcObject = new MediaStream([track]);
    document.body.append(video);
    let timer = 0;
    this.#stopReading = () => {
      window.clearInterval(timer);
      video.pause();
      video.srcObject = null;
      video.remove();
    };
    const take = () => {
      // Not `readyState`: WebKit can leave a stream's video at "nothing yet"
      // while it plays. A size means there's a picture to take.
      if (this.#done || video.videoWidth === 0) return;
      try {
        this.frame(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1_000) }));
      } catch {
        // Not a picture yet.
      }
    };
    void video
      .play()
      .then(() => {
        timer = window.setInterval(take, Math.floor(1_000 / this.speed.fps));
      })
      .catch(() => this.finish("dropped"));
  }

  frame(frame: VideoFrame): void {
    // A picture with no size is no picture (WebKit hands one over when it
    // can't read the screen), and no encoder takes it.
    if (frame.displayWidth === 0 || frame.displayHeight === 0) {
      frame.close();
      return;
    }
    this.#seen = true;
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
    // The line to the server is behind: skip this frame rather than queue
    // it. Skipped before it's encoded, it leaves the next one nothing
    // missing, so that one needn't be a key frame: one asked for here, five
    // to fifteen times the size, only put the line further behind.
    if (socket.bufferedAmount > MOST_WAITING) return;
    const size = fitWithin(frame.displayWidth, frame.displayHeight, this.speed.maxWidth, this.speed.maxHeight);
    let held = this.#encoders.get(codec);
    if (!held || held.width !== size.width || held.height !== size.height) {
      if (held) closeEncoder(held);
      const opened = this.openEncoder(codec, size.width, size.height);
      if (!opened) return;
      this.#encoders.set(codec, opened);
      held = opened;
    }
    // The computer is behind: skip it, before it's encoded, as above.
    if (held.encoder.encodeQueueSize > MOST_ENCODING) return;
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
    const packed = packFrame(codec, chunk.type === "key", chunk.timestamp, bytes);
    // Bigger than the server passes on: not sent, and the next a key frame.
    if (packed.byteLength > MAX_FRAME_BYTES) {
      const held = this.#encoders.get(codec);
      if (held) held.wantKey = true;
      return;
    }
    socket.send(packed);
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
    window.clearTimeout(this.#firstFrameTimer);
    window.clearInterval(this.#lookTimer);
    this.#looked = null;
    this.#stopReading?.();
    for (const held of this.#encoders.values()) closeEncoder(held);
    this.#encoders.clear();
    this.#latest?.close();
    this.#latest = null;
    if (this.source.kind === "track") for (const each of this.source.stream.getTracks()) each.stop();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    if (running === this) running = null;
    if (why !== null && why !== "ended") stopped(this.server, why);
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
