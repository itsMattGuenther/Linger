import type { ScreenCodec } from "../../generated/ScreenCodec";
import { CODEC_STRING, decoderConfig, encoderConfig, SCREEN_SPEEDS, type ScreenFps } from "./presets";

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
 * Whether this app shares from here (SPEC §4.20): the Windows app, for now.
 * Linux's WebKitGTK refuses the picker unless the shell answers its
 * permission request, and reads a window behind others too slowly (T-1907);
 * macOS comes with it. Elsewhere Share isn't offered; watching is.
 */
export function sharesFromHere(): boolean {
  return canPickScreen() && hasWebCodecs() && typeof navigator !== "undefined" && /\bWindows\b/.test(navigator.userAgent);
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
}

export { CODEC_STRING };
