import type { ScreenCodec } from "../../generated/ScreenCodec";

/** The two speeds a share starts at (SPEC §4.20). */
export type ScreenFps = 30 | 60;

/**
 * What each speed asks of the encoder (PROTOCOL §8), offered as Low and High
 * quality (#732). Low fits 1280×720 at 30, lighter on every line and on the
 * sharer's computer, and keeps its sharpness over its frames; High fits
 * 1920×1080 at 60 and keeps its frames, for motion. A smaller window is sent
 * at its own size either way. The server holds every share to 10 Mbit/s
 * whatever these say.
 */
export interface ScreenSpeed {
  fps: ScreenFps;
  maxWidth: number;
  maxHeight: number;
  /** Bits a second the encoder aims for, at most. */
  bitrate: number;
  /** What the picture is mostly: text that must stay sharp, or motion. */
  hint: "detail" | "motion";
}

export const SCREEN_SPEEDS: Readonly<Record<ScreenFps, ScreenSpeed>> = {
  30: { fps: 30, maxWidth: 1280, maxHeight: 720, bitrate: 2_500_000, hint: "detail" },
  60: { fps: 60, maxWidth: 1920, maxHeight: 1080, bitrate: 6_000_000, hint: "motion" },
};

/** A key frame at least this often, whatever the server asks: a player that lost its place finds it again. */
export const KEYFRAME_EVERY_MS = 10_000;

/**
 * The codec strings WebCodecs is asked for. H.264's is Constrained Baseline
 * at level 4.2, which reaches 1080p at 60 frames a second and which every
 * hardware encoder and phone decoder takes.
 */
export const CODEC_STRING: Readonly<Record<ScreenCodec, string>> = { vp8: "vp8", avc1: "avc1.42E02A" };

/**
 * A picture's size, fitted inside `maxWidth`×`maxHeight` with its shape kept,
 * never made bigger, and in even numbers, which every encoder wants.
 */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 2, height: 2 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** The encoder's settings for one format at one speed and size. */
export function encoderConfig(codec: ScreenCodec, speed: ScreenSpeed, width: number, height: number, hardware: boolean): VideoEncoderConfig {
  const config: VideoEncoderConfig = {
    codec: CODEC_STRING[codec],
    width,
    height,
    bitrate: speed.bitrate,
    framerate: speed.fps,
    latencyMode: "realtime",
    bitrateMode: "variable",
    hardwareAcceleration: hardware ? "prefer-hardware" : "no-preference",
  };
  if (codec === "avc1") config.avc = { format: "annexb" };
  // Newer engines read what the picture is mostly; older ones ignore it.
  Reflect.set(config, "contentHint", speed.hint === "detail" ? "text" : "motion");
  return config;
}

/** The decoder's settings for one format. */
export function decoderConfig(codec: ScreenCodec): VideoDecoderConfig {
  return { codec: CODEC_STRING[codec], optimizeForLatency: true };
}
