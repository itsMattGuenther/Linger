/**
 * Changing your own status from the list's top card
 * (docs/design/buddy-list.md, "The buddy list"): the status line, and going
 * away or coming back. Pure: each returns the whole status to save, with
 * every other field carried over, so a quick edit never wipes what you
 * wrote in Settings.
 */
import type { UserStatus } from "../../generated/UserStatus";
import { draftOf, MAX_LINE_CHARS, statusOf } from "../../lib/status";

/** Your status with a new line; blank clears it. */
export function withLine(status: UserStatus | null | undefined, line: string): UserStatus {
  return statusOf({ ...draftOf(status), line }, status);
}

/** Your status away with a message, or back (null) (SPEC §4.6). */
export function withAway(status: UserStatus | null | undefined, message: string | null): UserStatus {
  return statusOf({ ...draftOf(status), awayMessage: message ?? "" }, status);
}

/** What's wrong with a status line, in words, or null. */
export function lineProblem(line: string): string | null {
  const length = [...line.trim()].length;
  return length > MAX_LINE_CHARS ? `That's ${length - MAX_LINE_CHARS} characters too long.` : null;
}

/** The away messages offered before you've written your own (the prototype's). */
export const AWAY_PRESETS = [
  "back after work",
  "asleep 💤",
  "walking the dog 🐕",
  "out on the porch, phone inside",
  "at dinner, back in a bit 🍝",
  "reading. knock if it's good",
] as const;

/**
 * The presets to show: your own recent messages first (newest first, no
 * repeats), then the built-in ones, at most `limit`.
 */
export function awayChoices(recent: readonly string[], limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of [...recent, ...AWAY_PRESETS]) {
    const key = message.trim();
    if (key === "" || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(key);
    if (out.length === limit) break;
  }
  return out;
}

/** Remember a message you went away with, newest first, a few at most. */
export function rememberAway(recent: readonly string[], message: string, keep = 4): string[] {
  const trimmed = message.trim();
  if (trimmed === "" || (AWAY_PRESETS as readonly string[]).includes(trimmed)) return [...recent];
  return [trimmed, ...recent.filter((held) => held.toLowerCase() !== trimmed.toLowerCase())].slice(0, keep);
}
