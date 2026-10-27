import { useSyncExternalStore } from "react";
import type { ScreenCodec } from "../../generated/ScreenCodec";
import type { AuthedApi } from "../api";
import { isSound, readFrame } from "./frames";
import { playsSound, type SoundPlayer, soundPlayer } from "./listen";
import { decoderConfig } from "./presets";
import { playable } from "./probe";
import { closingOf, onSilence, openScreenSocket, readSaid, RETRIES, retryAfter } from "./socket";
import { onWatchSound, watchSoundOn, watchVolume } from "./sound";

/**
 * Watching somebody's screen (SPEC §4.20, PROTOCOL §8, #360), in the window
 * that shows it. The frames come on this window's own screen socket, the web
 * engine's WebCodecs plays them, and the newest is drawn on whatever canvas
 * the screen above the conversation gives it. One share at a time.
 *
 * A share that carries the computer's sound (#736) says so, and its sound
 * comes on the same socket while this window's sound button is on: played
 * by the shell in a desktop app, by the page on a phone (`listen.ts`).
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
   * device can't play; the share having ended; or the connection to the
   * server lost, and not got back.
   */
  status: "connecting" | "waiting" | "showing" | "unplayable" | "ended" | "lost";
  /** The picture's own size, once there is one. */
  width: number;
  height: number;
  /**
   * Over, and the person sharing has stopped sharing since: their next
   * share in that voice opens on this screen (`watchNext`).
   */
  awaitsNext?: boolean;
  /**
   * This window's line couldn't keep up, and the server skipped it forward
   * (`behind`): its picture is behind. Said for a while after the server
   * last said so, on this screen alone; the person sharing isn't told.
   */
  behind?: boolean;
  /**
   * The share carries the computer's sound (#736): `true` when this app can
   * play it, `"unplayable"` when it can't. Left out for a share without.
   * Whether it's playing is the sound button's (`sound.ts`).
   */
  sound?: true | "unplayable";
}

/** How long the screen says it's behind after the server last said so. */
export const BEHIND_SAID_MS = 6_000;

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
  const [decode, sound] = await Promise.all([playable(), playsSound()]);
  // Watch pressed again while this one waited for the player: the later
  // press is the one that counts, and this one's watch goes first.
  running?.finish();
  // Nothing it can play: say so, rather than ask the server for nothing.
  if (decode.length === 0) {
    running = null;
    publish({ server: options.server, place: options.place, who: options.who, target: options.target, status: "unplayable", width: 0, height: 0 });
    return;
  }
  const watching = new Watching(options.server, options.api, options.sessionId, options.target, decode, options.place, options.who, sound);
  running = watching;
  publish({ server: options.server, place: options.place, who: options.who, target: options.target, status: "connecting", width: 0, height: 0 });
  void watching.connect();
}

/** Stop watching. */
export function stopWatching(): void {
  running?.finish();
}

/** How loud the watched screen's sound plays, 0 to 1, now (the slider's own is kept by `sound.ts`). */
export function playWatchedAt(volume: number): void {
  running?.setVolume(volume);
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
  /** The share being shown carries sound (`showing`'s `sound`). */
  #carries = false;
  /** What plays the sound, while the share carries some and the button is on. */
  #player: SoundPlayer | null = null;
  #stopHearing: (() => void) | null = null;

  constructor(
    readonly server: string,
    readonly api: AuthedApi,
    readonly sessionId: string,
    public target: string,
    public decode: ScreenCodec[],
    public place: string,
    public who: string,
    /** This app can play a screen's sound (`listen.ts`). */
    readonly playsSound = false,
  ) {
    // The sound button, pressed while watching: the server is told, so
    // sound nobody here plays isn't sent.
    this.#stopHearing = onWatchSound((on) => {
      if (!this.playsSound || this.#done) return;
      this.#ask({ op: "sound", on });
      this.#listen();
    });
  }

  /** Whether this window asks for the sound: it can play it, and the button is on. */
  #wantsSound(): boolean {
    return this.playsSound && watchSoundOn();
  }

  /** Start or stop playing the sound, as the share and the button now say. */
  #listen(): void {
    const play = this.#carries && this.#wantsSound() && !this.#done;
    if (play && !this.#player) this.#player = soundPlayer(this.server, watchVolume());
    if (!play && this.#player) {
      this.#player.stop();
      this.#player = null;
    }
  }

  /** How loud the sound plays, 0 to 1, from the slider beside the screen. */
  setVolume(volume: number): void {
    this.#player?.volume(volume);
  }

  /** What `sound` says, as the share and this app's player stand. */
  #sound(): Pick<ScreenWatchState, "sound"> {
    if (!this.#carries) return {};
    return { sound: this.playsSound ? true : "unplayable" };
  }

  /** The state as the screens read it, at `status`. */
  #state(status: ScreenWatchState["status"], width = 0, height = 0): ScreenWatchState {
    return { server: this.server, place: this.place, who: this.who, target: this.target, status, width, height, ...this.#sound() };
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
      ...(this.#wantsSound() ? { sound: true } : {}),
    });
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      if (event.data instanceof ArrayBuffer) {
        if (isSound(event.data)) this.#player?.play(event.data);
        else this.frame(event.data);
      } else this.said(event.data);
    });
    socket.addEventListener("close", (event) => this.closed(socket, event.code));
    // Nothing from the server, not even its `alive`: the line died without
    // closing, and the picture would sit there as if the screen were still.
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
      this.#waitingForKey = true;
      window.setTimeout(() => void this.connect(), wait);
      return;
    }
    // You left voice (4007), or another of your windows watches instead
    // (4006): the screen goes, as Close would, rather than say they
    // stopped sharing, which they didn't. A share that ends says so
    // itself (`showing` with no target).
    if (this.#attempts === 0 && (why === "ended" || why === "replaced")) {
      this.finish();
      return;
    }
    // The share gone before it was watched: over. After a drop it's the
    // connection that went, whatever the server says when it's back (a
    // restart forgets every seat), so it says that, as for too many tries.
    this.end(why === "dropped" || why === "busy" || this.#attempts > 0 ? "lost" : "ended");
  }

  /** Watch another share, on the same socket. */
  switchTo(target: string): void {
    if (this.#done) return;
    this.target = target;
    this.#waitingForKey = true;
    this.#closeDecoder();
    this.#codec = null;
    // Another share: whether it has sound, its `showing` says.
    this.#carries = false;
    this.#listen();
    publish(this.#state("connecting"));
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "watch", target }));
    else if (socket && socket.readyState === WebSocket.CONNECTING) {
      // Its hello, sent once it opens, names the share before: one that
      // names this one goes instead, or the screen said whose it was over
      // somebody else's picture.
      this.#socket = null;
      socket.close();
      void this.connect();
    }
  }

  #behindTimer = 0;

  /** The server skipped this window forward: its picture is behind, said for a while. */
  #behind(): void {
    window.clearTimeout(this.#behindTimer);
    if (shown?.server === this.server && shown.behind !== true) publish({ ...shown, behind: true });
    this.#behindTimer = window.setTimeout(() => {
      if (!this.#done && shown?.server === this.server && shown.behind === true) publish({ ...shown, behind: false });
    }, BEHIND_SAID_MS);
  }

  said(data: unknown): void {
    const said = readSaid(data);
    if (said?.op === "behind") {
      this.#behind();
      return;
    }
    if (!said || said.op !== "showing") return;
    this.#attempts = 0;
    const target = typeof said.target === "string" ? said.target : null;
    const codec = said.codec === "vp8" || said.codec === "avc1" ? said.codec : null;
    this.#carries = target !== null && said.sound === true;
    this.#listen();
    if (target === null) {
      this.#closeDecoder();
      this.#codec = null;
      if (shown) {
        const { sound: _gone, ...rest } = shown;
        publish({ ...rest, status: "ended" });
      }
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
    else if (shown.sound !== this.#sound().sound) {
      // The same share, showing, shared again with sound or without.
      const { sound: _was, ...rest } = shown;
      publish({ ...rest, ...this.#sound() });
    }
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

  end(status: "ended" | "lost"): void {
    if (running === this && shown?.server === this.server) publish({ ...shown, status });
    this.finish(false);
  }

  /**
   * Stop. Only the watch that's running says anything to the screens: one
   * another took over ends quietly, or it cleared the screen the newer one
   * was showing.
   */
  finish(clear = true): void {
    if (this.#done) return;
    this.#done = true;
    const mine = running === this;
    window.clearTimeout(this.#behindTimer);
    if (this.#drawing !== 0) cancelAnimationFrame(this.#drawing);
    this.#stopHearing?.();
    this.#stopHearing = null;
    this.#player?.stop();
    this.#player = null;
    this.#closeDecoder();
    this.#pending?.close();
    this.#pending = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    if (mine) running = null;
    if (clear && mine && shown?.server === this.server) publish(null);
  }
}

/** Whether a watch is over: its screen stays, saying why, until it's closed. */
export function watchOver(status: ScreenWatchState["status"] | undefined): boolean {
  return status === "ended" || status === "lost";
}

/** Forget an ended watch, when its screen is closed. */
export function closeEnded(): void {
  if (!running && shown) publish(null);
}

/**
 * The person whose share this window's ended screen showed has stopped
 * sharing (#360): their next share in that voice opens on it, so somebody
 * who stops to pick another window or speed doesn't leave everybody
 * pressing Watch again. Only once they've stopped: a watch that ended while
 * they still share (another window of yours took it) doesn't come back by
 * itself, or two windows would take it from each other for ever. Closing
 * the screen forgets it.
 */
export function awaitNext(): void {
  if (shown && watchOver(shown.status) && shown.awaitsNext !== true) publish({ ...shown, awaitsNext: true });
}

/** They've shared again, as `target`: watch it on the screen still open, once. */
export async function watchNext(options: { server: string; api: AuthedApi; sessionId: string; target: string }): Promise<void> {
  if (shown?.awaitsNext !== true || shown.server !== options.server) return;
  const { place, who } = shown;
  // Taken before the watch starts, which can wait a moment for the player.
  publish({ ...shown, awaitsNext: false });
  await startWatching({ ...options, place, who });
}
