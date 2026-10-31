/**
 * The list window's side of Linger updating itself (#772): which version you
 * just updated to and what's in it, putting a notice off until tomorrow, and
 * whether now is a time to restart nobody would notice. The shell downloads,
 * checks and installs (`src-tauri/src/updates.rs`); the list decides when,
 * because only it knows whether somebody is in voice or sharing a screen.
 *
 * Everything here is kept on this computer. Nothing says which version
 * anybody runs to anybody (hard rule 4).
 */
import release from "./release-line.json";
import { isOlderVersion, type UpdateCheck, WAIT_MS } from "../../lib/updates";
import type { ModeStore } from "./conversations";

/**
 * How long nobody has used Linger before it restarts by itself to install a
 * waiting update (Matt, 2026-10-31). Idle, for presence, is ten minutes
 * (`IDLE_AFTER_MS`); this is longer, so a short break never costs anybody
 * their windows.
 */
export const RESTART_AWAY_MS = 30 * 60 * 1000;

/** The version Linger last started as, on this computer. */
const SEEN_KEY = "linger.next.update.seen";
/** A notice put off: which version, and until when. */
const NOT_NOW_KEY = "linger.next.update.notnow";

/**
 * The one line about what's in this release, from `client/src/next/core/release-line.json`,
 * which the release pull request fills in (`docs/releasing.md`). Only when it
 * names this version: a line left over from the release before says nothing
 * true about this one.
 */
export function releaseLine(version: string, said: { version: string; line: string } = release): string | null {
  const line = said.line.trim();
  return said.version === version && line !== "" ? line : null;
}

/**
 * The version this copy just updated to, once: on its first start after an
 * update. The first start of all (nothing seen yet) isn't an update, and
 * neither is starting a version older than one seen before. Remembers this one
 * either way.
 */
export function justUpdated(store: ModeStore | null, running: string): string | null {
  let seen: string | null = null;
  try {
    seen = store?.getItem(SEEN_KEY) ?? null;
    store?.setItem(SEEN_KEY, running);
  } catch {
    return null;
  }
  return seen !== null && isOlderVersion(seen, running) ? running : null;
}

/** The start of the next day here: what "until tomorrow" means. */
export function tomorrow(now: number): number {
  const day = new Date(now);
  day.setHours(24, 0, 0, 0);
  return day.getTime();
}

/** Put the notice about `version` off until tomorrow. A newer version brings a notice back at once. */
export function putOff(store: ModeStore | null, version: string, now: number): void {
  try {
    store?.setItem(NOT_NOW_KEY, JSON.stringify({ version, until: tomorrow(now) }));
  } catch {
    // Nowhere to keep it: the notice is back next time, which is no harm.
  }
}

/** Whether the notice about `version` was put off and it isn't tomorrow yet. */
export function putOffNow(store: ModeStore | null, version: string, now: number): boolean {
  try {
    const raw = store?.getItem(NOT_NOW_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    const { version: off, until } = parsed as { version?: unknown; until?: unknown };
    return off === version && typeof until === "number" && now < until;
  } catch {
    return false;
  }
}

/** What the list knows when it asks whether to restart by itself. */
export interface Moment {
  check: UpdateCheck | null;
  now: number;
  /** When anybody last used one of Linger's windows (`lastInput` in lib/watchPresence.ts). */
  lastInputAt: number;
  inVoice: boolean;
  sharing: boolean;
}

/**
 * Whether Linger should restart now, by itself, to install the update waiting
 * on disk: only a copy that installs by itself, only once the release is a
 * day old, only after half an hour with nobody using Linger, and never in
 * voice or while sharing a screen (#772).
 */
export function restartWhileAway({ check, now, lastInputAt, inVoice, sharing }: Moment): boolean {
  if (check?.kind !== "newer" || !check.silent || !check.downloaded) return false;
  if (inVoice || sharing) return false;
  if (check.published !== null && now - check.published < WAIT_MS) return false;
  return now - lastInputAt >= RESTART_AWAY_MS;
}
