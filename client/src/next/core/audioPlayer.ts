/**
 * The rules behind a shared audio file's player (#247): the words its time
 * says, how far a key moves its timeline, and how loud it starts.
 *
 * Linger draws that player itself rather than using the engine's own
 * controls, because WebKitGTK's leave out the volume slider on anything
 * shorter than 136px, which an audio player always is. Pure functions and a
 * storage key, so they are tested without a browser.
 */
import { durationText } from "../../lib/media";
import type { ModeStore } from "./conversations";

/** The last level shared audio played at on this computer; never sent anywhere. */
const VOLUME_KEY = "linger.next.audioVolume";

/**
 * How loud shared audio starts: the last level somebody listened at here, or
 * full. Silence is never remembered, so a file never starts out mute.
 */
export function loadAudioVolume(store: ModeStore | null): number {
  try {
    const level = Number(store?.getItem(VOLUME_KEY) ?? Number.NaN);
    return Number.isFinite(level) && level > 0 && level <= 1 ? level : 1;
  } catch {
    return 1;
  }
}

/** Remember a level that was let go of. Silence (muting by the slider) isn't kept. */
export function saveAudioVolume(store: ModeStore | null, level: number): void {
  if (!Number.isFinite(level) || level <= 0) return;
  try {
    store?.setItem(VOLUME_KEY, String(Math.min(1, level)));
  } catch {
    // Storage refused: this player keeps the level, the next starts at full.
  }
}

/** A length in seconds the player can use: known, finite and more than nothing. */
export function knownSeconds(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * How far one arrow key moves the timeline, and the steps a drag snaps to: a
 * second, or a tenth of one in a clip under a minute, where a second would
 * be a jump across the line. Page Up and Down move a tenth of the file, and
 * Home and End go to either end (the range input's own keys).
 */
export function seekStep(duration: number | null): number {
  return duration !== null && duration >= 60 ? 1 : 0.1;
}

/**
 * How far short of the end a seek to the end lands, in seconds: less than
 * anybody hears.
 */
export const END_MARGIN = 0.05;

/**
 * Where the sound actually goes for a seek to `to`. To seek, WebKit (the
 * Linux app) asks for the file from that point on, and a seek to the exact
 * end asks for a range starting past the last byte. The server rightly
 * answers 416, and WebKit takes that as a failed load, so End on the
 * timeline said "Couldn't load this audio" (#343). A seek to the end lands a
 * hair before it; the timeline still shows the end.
 */
export function seekTarget(to: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, to);
  return Math.min(Math.max(0, to), Math.max(0, duration - END_MARGIN));
}

/** A position on the timeline's steps, so its thumb and its lit part agree. */
export function onStep(position: number, duration: number | null): number {
  const step = seekStep(duration);
  const snapped = Math.round(Math.max(0, position) / step) * step;
  // Rounding a tenth leaves 0.30000000000000004; the slider wants 0.3.
  const tidy = Number(snapped.toFixed(1));
  return duration === null ? tidy : Math.min(duration, tidy);
}

/**
 * A position as words: whole seconds gone by, as players count, so 3.6s in
 * is still "0:03"; at the end it is the length, however that was rounded.
 * Within END_MARGIN of it counts as the end, where a seek to the end lands.
 */
function positionText(position: number, duration: number | null): string {
  if (duration !== null && position >= duration - END_MARGIN) return durationText(duration * 1000);
  return durationText(Math.floor(Math.max(0, position)) * 1000);
}

/** What the card shows: "0:12 / 3:45", or just "0:12" while the length isn't known. */
export function timeText(position: number, duration: number | null): string {
  const at = positionText(position, duration);
  return duration === null ? at : `${at} / ${durationText(duration * 1000)}`;
}

/**
 * The widest the time can get for this file, drawn invisibly behind it so the
 * name beside it never shifts as the seconds tick over ("9:59" to "10:00").
 */
export function timeSizer(duration: number | null): string {
  return duration === null ? timeText(0, null) : timeText(duration, duration);
}

/** What a screen reader hears on the timeline: "0:12 of 3:45". */
export function timeWords(position: number, duration: number | null): string {
  const at = positionText(position, duration);
  return duration === null ? at : `${at} of ${durationText(duration * 1000)}`;
}
