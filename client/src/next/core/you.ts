/**
 * Changing your own status from the list's top card
 * (docs/design/buddy-list.md, "The buddy list"): the status line, and going
 * away or coming back. Pure: each returns the whole status to save, with
 * every other field carried over, so a quick edit never wipes what you
 * wrote in Settings, your labelled fields included (#270).
 */
import type { UserStatus } from "../../generated/UserStatus";
import { MAX_LINE_CHARS } from "../../lib/status";
import { draftOf, statusOf } from "./status";

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

/** The away messages a new bank starts with (the prototype's). */
export const AWAY_PRESETS = [
  "back after work",
  "asleep 💤",
  "walking the dog 🐕",
  "out on the porch, phone inside",
  "at dinner, back in a bit 🍝",
  "reading. knock if it's good",
] as const;

/**
 * How many away messages your bank holds (SPEC §4.6, #708): the ones the
 * picker offers, newest first, no repeats. It starts as the built-in ones.
 * Going away with a message puts it at the top, and × takes one out for
 * good, a built-in one too, so over time it becomes the ones you use. Each
 * device keeps its own, as a convenience; no server sees it.
 */
export const AWAY_BANK_SIZE = 6;

/** Messages as a bank holds them: trimmed, no blanks, no repeats whatever their case, six at most. */
function tidied(messages: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    const words = message.trim();
    if (words === "" || seen.has(words.toLowerCase())) continue;
    seen.add(words.toLowerCase());
    out.push(words);
    if (out.length === AWAY_BANK_SIZE) break;
  }
  return out;
}

/**
 * A device's first bank. Before #708 a device kept only your own recent
 * messages and added the built-in ones when it showed them, so the bank
 * starts from those, then the built-in ones: nobody loses theirs.
 */
export function startingBank(recent: readonly string[]): string[] {
  return tidied([...recent, ...AWAY_PRESETS]);
}

/** A bank as a device kept it, or null when what's kept isn't one. */
export function bankOf(kept: unknown): string[] | null {
  return Array.isArray(kept) ? tidied(kept.filter((item): item is string => typeof item === "string")) : null;
}

/**
 * The bank once you've gone away with a message: it's at the top, and when
 * that makes seven, the bottom one drops off, the one you've gone longest
 * without. A built-in one you took out comes back the same way.
 */
export function rememberAway(bank: readonly string[], message: string): string[] {
  return message.trim() === "" ? [...bank] : tidied([message, ...bank]);
}

/** The bank without one message, × beside it. Nothing takes its place until you go away with another. */
export function forgetAway(bank: readonly string[], message: string): string[] {
  const key = message.trim().toLowerCase();
  return bank.filter((held) => held.toLowerCase() !== key);
}
