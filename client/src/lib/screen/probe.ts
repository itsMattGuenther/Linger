import { useSyncExternalStore } from "react";
import type { ScreenCodec } from "../../generated/ScreenCodec";
import { CODEC_STRING, decoderConfig, encoderConfig, SCREEN_SPEEDS, type ScreenFps } from "./presets";
import { openReader, readsHere } from "./reader";

/**
 * What this app can make and play (PROTOCOL §8, "The server picks the
 * formats"): asked of the web engine's own WebCodecs, once each. A web
 * engine without WebCodecs (an iPhone before iOS 16.4) can do neither, and
 * the app offers neither Share nor Watch.
 */

let plays: Promise<ScreenCodec[]> | null = null;
const makes = new Map<ScreenFps, Promise<{ codecs: ScreenCodec[]; hardware: ReadonlySet<ScreenCodec> }>>();

/** Whether this web engine has WebCodecs video at all. */
export function hasWebCodecs(): boolean {
  return typeof globalThis.VideoEncoder === "function" && typeof globalThis.VideoDecoder === "function" && typeof globalThis.EncodedVideoChunk === "function";
}

/** Whether this web engine can ask the system for a screen. */
export function canPickScreen(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

async function supported(test: () => Promise<{ supported?: boolean }>): Promise<boolean> {
  try {
    return (await test()).supported === true;
  } catch {
    return false;
  }
}

/**
 * Whether a worker here can read a screen (`reader.worker.ts`): null until
 * one has said. Asked once, the first time Share might be offered, which is
 * in a room's voice, long after the shell has turned the track processor on.
 */
let workerReads: boolean | null = null;
let askingWorker = false;
const workerListeners = new Set<() => void>();

function askWorker(): void {
  if (askingWorker) return;
  askingWorker = true;
  const worker = openReader();
  if (!worker) {
    workerReads = false;
    return;
  }
  void readsHere(worker).then((reads) => {
    worker.terminate();
    workerReads = reads;
    for (const listener of workerListeners) listener();
  });
}

/**
 * Whether this app shares from here (SPEC §4.20): the Windows app, and the
 * Linux app where a worker can read the screen, which needs the shell to
 * have answered WebKitGTK's permission request and turned its track
 * processor on (T-1907). A Mac isn't offered it yet: nobody has tried its
 * picker. Elsewhere Share isn't offered; watching is.
 */
export function sharesFromHere(): boolean {
  if (!canPickScreen() || !hasWebCodecs() || typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  if (/\bWindows\b/.test(agent)) return true;
  if (!/\bLinux\b/.test(agent) || /\bAndroid\b/.test(agent)) return false;
  askWorker();
  return workerReads === true;
}

/**
 * `sharesFromHere`, for a screen, drawn again once the worker has said;
 * false without asking until Share is `wanted` (in voice, on a server that
 * passes screens on).
 */
export function useSharesFromHere(wanted: boolean): boolean {
  return useSyncExternalStore(subscribeWorker, wanted ? sharesFromHere : notWanted);
}

function notWanted(): boolean {
  return false;
}

function subscribeWorker(listener: () => void): () => void {
  workerListeners.add(listener);
  return () => workerListeners.delete(listener);
}

/** The formats this app can play. */
export function playable(): Promise<ScreenCodec[]> {
  if (!plays) {
    plays = (async () => {
      if (!hasWebCodecs()) return [];
      const found: ScreenCodec[] = [];
      for (const codec of ["avc1", "vp8"] as const) {
        if (await supported(() => VideoDecoder.isConfigSupported(decoderConfig(codec)))) found.push(codec);
      }
      return found;
    })();
  }
  return plays;
}

/**
 * The formats this app can make at `fps`, best first: H.264 first only when
 * the graphics card makes it, since the card's encoder costs the computer
 * next to nothing; then VP8, which every engine plays; H.264 in software
 * only when there is nothing else.
 */
export function makeable(fps: ScreenFps): Promise<{ codecs: ScreenCodec[]; hardware: ReadonlySet<ScreenCodec> }> {
  let found = makes.get(fps);
  if (!found) {
    found = (async () => {
      if (!hasWebCodecs()) return { codecs: [], hardware: new Set<ScreenCodec>() };
      const speed = SCREEN_SPEEDS[fps];
      const test = (codec: ScreenCodec, hardware: boolean) => supported(() => VideoEncoder.isConfigSupported(encoderConfig(codec, speed, speed.maxWidth, speed.maxHeight, hardware)));
      const hardware = new Set<ScreenCodec>();
      if (await test("avc1", true)) hardware.add("avc1");
      const vp8 = await test("vp8", false);
      const softAvc = !hardware.has("avc1") && (await test("avc1", false));
      const codecs: ScreenCodec[] = [];
      if (hardware.has("avc1")) codecs.push("avc1");
      if (vp8) codecs.push("vp8");
      if (softAvc && codecs.length === 0) codecs.push("avc1");
      return { codecs, hardware };
    })();
    makes.set(fps, found);
  }
  return found;
}

/** For tests: forget what was found, so a page can probe again. */
export function forgetProbes(): void {
  plays = null;
  makes.clear();
  workerReads = null;
  askingWorker = false;
}

export { CODEC_STRING };
