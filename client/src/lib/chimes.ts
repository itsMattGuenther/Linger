/**
 * One small acoustic vocabulary: soft, related notes with a rounded attack.
 * No downloaded assets, random variations or background audio. The player in
 * sound.ts owns all policy; this score also renders into offline review clips.
 */
import type { SoundCue } from "./sound";

const D = 293.665;
const E = 329.628;
const F = 369.994;
const A = 440;
const B = 493.883;

interface Chime {
  notes: readonly number[];
  gain: number;
  spacing: number;
  decay: number;
}

/** Opposite actions have opposite contours; peers are quieter than your own actions. */
export const CHIMES: Record<Exclude<SoundCue, "knock">, Chime> = {
  "voice-join": { notes: [D, F, A], gain: 0.048, spacing: 0.09, decay: 0.24 },
  "voice-leave": { notes: [A, F, D], gain: 0.042, spacing: 0.09, decay: 0.22 },
  "voice-move": { notes: [F, E, A], gain: 0.043, spacing: 0.08, decay: 0.22 },
  "peer-join": { notes: [A, D * 2], gain: 0.032, spacing: 0.09, decay: 0.2 },
  "peer-leave": { notes: [D * 2, A], gain: 0.028, spacing: 0.09, decay: 0.2 },
  mute: { notes: [F, D], gain: 0.03, spacing: 0.065, decay: 0.14 },
  unmute: { notes: [D, F], gain: 0.03, spacing: 0.065, decay: 0.14 },
  deafen: { notes: [A, E, D], gain: 0.03, spacing: 0.07, decay: 0.17 },
  undeafen: { notes: [D, E, A], gain: 0.03, spacing: 0.07, decay: 0.17 },
  dm: { notes: [B, F * 2], gain: 0.038, spacing: 0.13, decay: 0.28 },
  room: { notes: [F * 2], gain: 0.025, spacing: 0, decay: 0.22 },
};

function note(
  ctx: BaseAudioContext,
  frequency: number,
  at: number,
  volume: number,
  decay: number,
): void {
  // A faint octave gives the sine a little wood-and-glass character without
  // the sharp upper harmonics of a triangle or square wave.
  for (const [harmonic, strength] of [
    [1, 1],
    [2, 0.12],
  ] as const) {
    const oscillator = ctx.createOscillator();
    const level = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency * harmonic, at);
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(volume * strength, at + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    level.gain.linearRampToValueAtTime(0, at + decay + 0.015);
    oscillator.connect(level).connect(ctx.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      level.disconnect();
    };
    oscillator.start(at);
    oscillator.stop(at + decay + 0.02);
  }
}

function tap(ctx: BaseAudioContext, at: number, volume: number): void {
  const oscillator = ctx.createOscillator();
  const level = ctx.createGain();
  const wood = ctx.createBiquadFilter();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(180, at);
  oscillator.frequency.exponentialRampToValueAtTime(90, at + 0.08);
  wood.type = "lowpass";
  wood.frequency.setValueAtTime(700, at);
  level.gain.setValueAtTime(0, at);
  level.gain.linearRampToValueAtTime(volume, at + 0.003);
  level.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  level.gain.linearRampToValueAtTime(0, at + 0.1);
  oscillator.connect(wood).connect(level).connect(ctx.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    wood.disconnect();
    level.disconnect();
  };
  oscillator.start(at);
  oscillator.stop(at + 0.11);
}

/** Schedule only after the caller has checked mute, quiet hours and category switches. */
export function scheduleChime(
  ctx: BaseAudioContext,
  cue: SoundCue,
  at: number,
): void {
  if (cue === "knock") {
    tap(ctx, at, 0.16);
    tap(ctx, at + 0.14, 0.12);
    return;
  }
  const chime = CHIMES[cue];
  for (const [index, frequency] of chime.notes.entries()) {
    note(ctx, frequency, at + index * chime.spacing, chime.gain, chime.decay);
  }
}

/**
 * Keep the attack intact through both graph setup and output startup. WebKitGTK
 * can lose the beginning of a new audible run; actual zero samples at the head
 * of one buffer give it time to settle. Scheduling a source later still leaves
 * the backend idle until that source starts, so it is not equivalent padding.
 */
export async function renderChime(cue: SoundCue, sampleRate: number): Promise<AudioBuffer> {
  const duration = cue === "knock"
    ? 0.14 + 0.11
    : (CHIMES[cue].notes.length - 1) * CHIMES[cue].spacing + CHIMES[cue].decay + 0.02;
  const lead = 0.05;
  const ctx = new OfflineAudioContext(1, Math.ceil((duration + lead) * sampleRate), sampleRate);
  scheduleChime(ctx, cue, lead);
  return ctx.startRendering();
}
