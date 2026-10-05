/**
 * The emoji you've used lately and the skin tone you chose (#359), kept on
 * this computer only: nothing about them goes to any server. A private
 * window, or storage that's switched off, simply starts empty each time.
 */
import type { SkinTone } from "./index";

const RECENT_KEY = "linger.emoji.recent";
const TONE_KEY = "linger.emoji.tone";
/** Two rows of the picker. */
export const RECENT_MAX = 18;

/**
 * What a recent pick is: a Unicode emoji's glyph (its tone-free form), or a
 * server's own emoji by name, shown again on any server that has one by it.
 */
export interface RecentEmoji {
  glyph?: string;
  name?: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage off or full: the picker still works, it just won't remember.
  }
}

const same = (a: RecentEmoji, b: RecentEmoji) => (a.glyph !== undefined ? a.glyph === b.glyph : a.name === b.name);

/** The newest first. */
export function recentEmoji(): RecentEmoji[] {
  const held = read<unknown>(RECENT_KEY, []);
  return Array.isArray(held) ? (held.filter((one) => one && typeof one === "object") as RecentEmoji[]).slice(0, RECENT_MAX) : [];
}

/** Put one at the front, once. */
export function rememberEmoji(used: RecentEmoji): RecentEmoji[] {
  const next = [used, ...recentEmoji().filter((one) => !same(one, used))].slice(0, RECENT_MAX);
  write(RECENT_KEY, next);
  return next;
}

export function skinTone(): SkinTone {
  const held = read<unknown>(TONE_KEY, 0);
  return typeof held === "number" && held >= 0 && held <= 5 ? (held as SkinTone) : 0;
}

export function setSkinTone(tone: SkinTone): void {
  write(TONE_KEY, tone);
}
