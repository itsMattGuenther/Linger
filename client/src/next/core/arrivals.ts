/**
 * Arrivals (decisions 12 and 13): "Callie came into #general". The list
 * window notices somebody moving into a room, says so on a card that goes by
 * itself, and, if the door chime is on, plays it. Pure, so the rules are
 * tested without a window:
 *
 * - only into a room everybody can see (a DM is nobody's business, SPEC §4.13);
 * - never you, and never on a server's first word (connecting, reconnecting):
 *   that's everybody already there, not anybody arriving;
 * - no card in quiet hours (they're silent anyway; quiet hours hold them too);
 * - a card at most once a minute per person, and the chime at most once every
 *   five minutes per person, so somebody hopping between rooms isn't noise.
 */
import type { PresenceEntry } from "../../generated/PresenceEntry";
import { inQuietHours, type SoundPrefs } from "../../lib/sound";

/** How long an arrival card stays. */
export const ARRIVAL_TTL_MS = 6_000;
/** A person's next card waits at least this long. */
export const CARD_EVERY_MS = 60_000;
/** A person's next door chime waits at least this long (SPEC §4.1's limit). */
export const CHIME_EVERY_MS = 5 * 60_000;

/** Where each person on a server is, by user id: a room id, or null. */
export type WhereAll = ReadonlyMap<string, string | null>;

export function whereAll(presence: readonly PresenceEntry[]): Map<string, string | null> {
  return new Map(presence.map((entry) => [entry.user_id, entry.state === "in_room" ? entry.room_id : null]));
}

/** Who moved into one of `rooms` since `before`: user id and room id. */
export function arrivalsBetween(before: WhereAll, now: WhereAll, me: string | null, rooms: ReadonlySet<string>): { userId: string; roomId: string }[] {
  const out: { userId: string; roomId: string }[] = [];
  for (const [userId, roomId] of now) {
    if (userId === me || roomId === null || !rooms.has(roomId)) continue;
    if (before.get(userId) === roomId) continue;
    out.push({ userId, roomId });
  }
  return out;
}

/** Whether quiet hours are holding arrival cards right now. Mute doesn't: a card makes no sound. */
export function cardsHushed(prefs: SoundPrefs, at: Date): boolean {
  return prefs.quietHours && inQuietHours(at, prefs.quietFrom, prefs.quietUntil);
}

/** Whether something last done at `last` (per person) may be done again at `now`. */
export function due(last: number | undefined, now: number, every: number): boolean {
  return last === undefined || now - last >= every;
}

const ARRIVALS_KEY = "linger.next.arrivalCards";

/** Arrival cards are on unless somebody turned them off (decision 13). */
export function loadArrivalCards(store: Pick<Storage, "getItem"> | null): boolean {
  try {
    return store?.getItem(ARRIVALS_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveArrivalCards(store: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    store?.setItem(ARRIVALS_KEY, on ? "true" : "false");
  } catch {
    // Storage refused: the choice lasts for this run.
  }
}
