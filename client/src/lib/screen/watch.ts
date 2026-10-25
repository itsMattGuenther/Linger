import { useSyncExternalStore } from "react";
import type { ScreenCodec } from "../../generated/ScreenCodec";
import type { AuthedApi } from "../api";
import { readFrame } from "./frames";
import { decoderConfig } from "./presets";
import { playable } from "./probe";
import { closingOf, openScreenSocket, readSaid, RETRIES, retryAfter } from "./socket";

/**
 * Watching somebody's screen (SPEC §4.20, PROTOCOL §8, #360), in the window
 * that shows it. The frames come on this window's own screen socket, the web
 * engine's WebCodecs plays them, and the newest is drawn on whatever canvas
 * the screen above the conversation gives it. One share at a time.
 */

export interface ScreenWatchState {
  server: string;
  /** The room or DM whose voice the share is in. */
  place: string;
  /** The person sharing, by user id. */
  who: string;
  /** The session whose share this is. */
  target: string;
  /**
   * Connecting; waiting for its first picture; showing it; a share this
   * device can't play; or the share having ended.
   */
  status: "connecting" | "waiting" | "showing" | "unplayable" | "ended";
  /** The picture's own size, once there is one. */
  width: number;
  height: number;
}

let shown: ScreenWatchState | null = null;
const listeners = new Set<() => void>();

function publish(next: ScreenWatchState | null): void {
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What this window is watching, for its screens. */
export function useScreenWatch(): ScreenWatchState | null {
  return useSyncExternalStore(subscribe, () => shown);
}

/** What this window is watching, outside React (tests). */
export function currentWatch(): ScreenWatchState | null {
  return shown;
}

let running: Watching | null = null;

/** Watch `target`'s share on `server`, in place of whatever this window watched. */
export async function startWatching(options: { server: string; api: AuthedApi; sessionId: string; target: string; place: string; who: string }): Promise<void> {
  if (running && running.server === options.server && running.sessionId === options.sessionId) {
    running.place = options.place;
    running.who = options.who;
    running.switchTo(options.target);
    return;
  }
  running?.finish();
  const decode = await playable();
  // Nothing it can play: say so, rather than ask the server for nothing.
  if (decode.length === 0) {
    running = null;
    publish({ server: options.server, place: options.place, who: options.who, target: options.target, status: "unplayable", width: 0, height: 0 });
    return;
  }
  const watching = new Watching(options.server, options.api, options.sessionId, options.target, decode, options.place, options.who);
  running = watching;
  publish({ server: options.server, place: options.place, who: options.who, target: options.target, status: "connecting", width: 0, height: 0 });
  void watching.connect();
}

/** Stop watching. */
export function stopWatching(): void {
  running?.finish();
}

/** Where the picture is drawn: the screen above the conversation's canvas, or null while it isn't on screen. */
export function drawOn(canvas: HTMLCanvasElement | null): void {
  canvasNow = canvas;
  running?.redraw();
}

/** The picture's canvas, while there is one. */
let canvasNow: HTMLCanvasElement | null = null;

/** How many frames may wait in the decoder before the rest are skipped to the next key frame. */
const MOST_DECODING = 6;
/** A format whose decoder fails this many times in this long is given up on. */
const FAILS = 3;
const FAILS_WITHIN_MS = 10_000;

class Watching {
  #socket: WebSocket | null = null;
  #attempts = 0;
  #decoder: VideoDecoder | null = null;
  #codec: ScreenCodec | null = null;
  #waitingForKey = true;
  #pending: VideoFrame | null = null;
  #drawing = 0;
  #fails: number[] = [];
  #done = false;

  constructor(
    readonly server: string,
    readonly api: AuthedApi,
    readonly sessionId: string,
    public target: string,
    public decode: ScreenCodec[],
    public place: string,
    public who: string,
  ) {}

  /** The state as the screens read it, at `status`. */
  #state(status: ScreenWatchState["status"], width = 0, height = 0): ScreenWatchState {
    return { server: this.server, place: this.place, who: this.who, target: this.target, status, width, height };
  }

  async connect(): Promise<void> {
    if (this.#done) return;
    let token: string;
    try {
      token = (await this.api.accessToken()).token;
    } catch {
      this.end("ended");
      return;
    }
    if (this.#done) return;
    const socket = openScreenSocket(this.api.baseUrl, {
      op: "watch",
      token,
      session_id: this.sessionId,
      target: this.target,
      decode: this.decode,
    });
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      if (event.data instanceof ArrayBuffer) this.frame(event.data);
      else this.said(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket || this.#done) return;
      this.#socket = null;
      const why = closingOf(event.code);
      if (why === "dropped" && this.#attempts < RETRIES) {
        const wait = retryAfter(this.#attempts);
        this.#attempts += 1;
        this.#waitingForKey = true;
        window.setTimeout(() => void this.connect(), wait);
        return;
      }
      // Left voice, the share gone, another window watching instead: over.
      this.end("ended");
    });
  }

  /** Watch another share, on the same socket. */
  switchTo(target: string): void {
    if (this.#done) return;
    this.target = target;
    this.#waitingForKey = true;
    this.#closeDecoder();
    this.#codec = null;
    publish(this.#state("connecting"));
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "watch", target }));
  }

  said(data: unknown): void {
    const said = readSaid(data);
    if (!said || said.op !== "showing") return;
    this.#attempts = 0;
    const target = typeof said.target === "string" ? said.target : null;
    const codec = said.codec === "vp8" || said.codec === "avc1" ? said.codec : null;
    if (target === null) {
      this.#closeDecoder();
      this.#codec = null;
      if (shown) publish({ ...shown, status: "ended" });
      return;
    }
    this.target = target;
    if (codec === null) {
      this.#closeDecoder();
      this.#codec = null;
      publish(this.#state("unplayable"));
      return;
    }
    if (codec !== this.#codec || !this.#decoder) this.#openDecoder(codec);
    this.#waitingForKey = true;
    if (shown?.target !== target || shown.status !== "showing") publish(this.#state("waiting", shown?.width ?? 0, shown?.height ?? 0));
  }

  frame(buffer: ArrayBuffer): void {
    const frame = readFrame(buffer);
    const decoder = this.#decoder;
    if (!frame || !decoder || frame.codec !== this.#codec || decoder.state !== "configured") return;
    if (this.#waitingForKey && !frame.key) return;
    if (!frame.key && decoder.decodeQueueSize > MOST_DECODING) {
      // This computer is behind: skip to the next key frame and ask for one.
      this.#waitingForKey = true;
      this.#ask({ op: "keyframe" });
      return;
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? "key" : "delta", timestamp: frame.micros, data: frame.data }));
      this.#waitingForKey = false;
    } catch {
      this.#broken();
    }
  }

  #openDecoder(codec: ScreenCodec): void {
    this.#closeDecoder();
    this.#codec = codec;
    try {
      const decoder = new VideoDecoder({
        output: (picture) => this.#show(picture),
        error: () => this.#broken(),
      });
      decoder.configure(decoderConfig(codec));
      this.#decoder = decoder;
    } catch {
      this.#broken();
    }
  }

  #closeDecoder(): void {
    const decoder = this.#decoder;
    this.#decoder = null;
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      // Already gone.
    }
  }

  /**
   * The player broke: start it again from a key frame. One that keeps
   * breaking on a format means this engine can't play it after all, so the
   * server is told, and picks another for this watcher if the sharer has one.
   */
  #broken(): void {
    if (this.#done) return;
    const codec = this.#codec;
    const now = performance.now();
    this.#fails = [...this.#fails, now].filter((at) => now - at < FAILS_WITHIN_MS);
    if (codec && this.#fails.length >= FAILS) {
      this.#fails = [];
      this.decode = this.decode.filter((one) => one !== codec);
      this.#closeDecoder();
      this.#codec = null;
      this.#ask({ op: "watch", target: this.target, decode: this.decode });
      return;
    }
    if (codec) this.#openDecoder(codec);
    this.#waitingForKey = true;
    this.#ask({ op: "keyframe" });
  }

  #ask(ask: object): void {
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ask));
  }

  /** A new picture: keep only the newest, and draw it on the next frame of the screen. */
  #show(picture: VideoFrame): void {
    if (this.#done) {
      picture.close();
      return;
    }
    this.#pending?.close();
    this.#pending = picture;
    if (shown && (shown.status !== "showing" || shown.width !== picture.displayWidth || shown.height !== picture.displayHeight)) {
      publish({ ...shown, status: "showing", width: picture.displayWidth, height: picture.displayHeight });
    }
    if (this.#drawing === 0) this.#drawing = requestAnimationFrame(() => this.#draw());
  }

  #draw(): void {
    this.#drawing = 0;
    const picture = this.#pending;
    const canvas = canvasNow;
    if (!picture || !canvas) return;
    if (canvas.width !== picture.displayWidth) canvas.width = picture.displayWidth;
    if (canvas.height !== picture.displayHeight) canvas.height = picture.displayHeight;
    canvas.getContext("2d")?.drawImage(picture, 0, 0);
    // The last picture stays drawn; it's closed when the next arrives.
  }

  redraw(): void {
    if (this.#pending && this.#drawing === 0) this.#drawing = requestAnimationFrame(() => this.#draw());
  }

  end(status: "ended"): void {
    if (shown?.server === this.server) publish({ ...shown, status });
    this.finish(false);
  }

  finish(clear = true): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#drawing !== 0) cancelAnimationFrame(this.#drawing);
    this.#closeDecoder();
    this.#pending?.close();
    this.#pending = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    if (running === this) running = null;
    if (clear && shown?.server === this.server) publish(null);
  }
}

/** Forget an ended watch, when its screen is closed. */
export function closeEnded(): void {
  if (!running && shown) publish(null);
}
