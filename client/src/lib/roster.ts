/**
 * What the roster shows, worked out as data.
 *
 * The card stack is the product thesis (SPEC §3): people are the primary
 * surface, and an empty server should still feel like a house with the lights
 * on. All of the deciding — who is where, what order they come in, how long ago
 * "a while" is — happens here, as pure functions over the store's snapshot, so
 * it can be tested instead of squinted at.
 *
 * Nothing in this file counts anything (SPEC §4.2). It sorts people and it
 * turns moments into short labels; there is no quantity to render and no
 * endpoint that would answer if there were.
 */
import type { PresenceEntry } from "../generated/PresenceEntry";
import type { PresenceState } from "../generated/PresenceState";
import type { Room } from "../generated/Room";
import type { User } from "../generated/User";

/** One person's card, with everything it needs already looked up. */
export interface RosterEntry {
  user: User;
  state: PresenceState;
  /** The room they are in, when we hold it. Null unless they are in one. */
  room: Room | null;
  /**
   * The away message, which supersedes the status line when set (SPEC §4.6).
   * Null for somebody who is plainly here: an old one left on a status would
   * otherwise sit under a dot that says they are in the room.
   */
  awayMessage: string | null;
  /**
   * When they were last here, for people who are not. Null when the server has
   * never seen them — a fresh account that has not signed in.
   */
  seenAt: number | null;
  /** You. The roster includes you, because your own status is a thing to see. */
  isMe: boolean;
  /**
   * Their microphone is on somewhere we can see (SPEC §4.14). The same
   * weight of signal as being in a room, drawn the same quiet way: a word on
   * the card, not a badge.
   */
  inVoice: boolean;
}

/**
 * Card order. State first, so whoever is actually in a room is at the top and
 * the people who are gone settle to the bottom; then by name, so the stack
 * stops shuffling itself while you are looking at it.
 */
const RANK: Record<PresenceState, number> = {
  in_room: 0,
  around: 1,
  idle: 2,
  away: 3,
  offline: 4,
};

/**
 * Fold the store's snapshot into the cards, in the order they are drawn.
 *
 * `offlineAt` is when this client watched somebody's connection go away. It
 * beats `last_seen_at` when we have it: the server writes that column on
 * disconnect but never pushes the new value, so for anyone who left while we
 * were watching, our own observation is the fresher of the two.
 */
export function buildRoster(input: {
  users: readonly User[];
  presence: readonly PresenceEntry[];
  rooms: readonly Room[];
  meId: string | null;
  offlineAt: Readonly<Record<string, number>>;
  now: number;
  /** User ids with a microphone on anywhere we can see. Nobody, if absent. */
  inVoice?: ReadonlySet<string>;
}): RosterEntry[] {
  const { users, presence, rooms, meId, offlineAt, now } = input;
  const inVoice = input.inVoice ?? new Set<string>();
  const byUser = new Map(presence.map((entry) => [entry.user_id, entry]));
  const roomsById = new Map(rooms.map((room) => [room.id, room]));

  const cards = users.map((user): RosterEntry => {
    const entry = byUser.get(user.id);
    // No entry at all means the server is not tracking them, and it only
    // tracks connected clients. Absent is offline.
    const state = entry?.state ?? "offline";
    const here = state !== "offline";
    const roomId = (here ? entry?.room_id : null) ?? null;
    const room = roomId === null ? null : (roomsById.get(roomId) ?? null);
    // What they last left on their status. Presence carries the live one and
    // wins; this is the one that outlives the session it was written in.
    const kept = user.status?.away_message ?? null;
    return {
      user,
      state,
      room,
      awayMessage: entry?.away_message ?? (here && state !== "idle" ? null : kept),
      seenAt: here ? now : (offlineAt[user.id] ?? user.last_seen_at),
      isMe: user.id === meId,
      inVoice: inVoice.has(user.id),
    };
  });

  return cards.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      a.user.display_name.localeCompare(b.user.display_name, undefined, {
        sensitivity: "base",
      }),
  );
}

/** The state, said out loud. Carries the presence dot for a screen reader. */
export function stateWord(state: PresenceState): string {
  switch (state) {
    case "in_room":
      return "in a room";
    case "around":
      return "around";
    case "idle":
      return "idle";
    case "away":
      return "away";
    case "offline":
      return "offline";
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A "month" for the purpose of a two-character label. Nobody is counting. */
const MONTH_MS = 30 * DAY_MS;

/**
 * How long ago, in the shortest honest form: `now`, `40m`, `2h`, `3d`, `2w`,
 * `5mo`. Pure, and takes the moment, because "2h" is only true relative to one.
 *
 * It rounds down, always. Saying "1h" a few seconds early would be the app
 * being confidently wrong about the one number on the card.
 */
export function shortAgo(at: number, now: number): string {
  const span = Math.max(0, now - at);
  if (span < MINUTE_MS) return "now";
  if (span < HOUR_MS) return `${Math.floor(span / MINUTE_MS)}m`;
  if (span < DAY_MS) return `${Math.floor(span / HOUR_MS)}h`;
  if (span < WEEK_MS) return `${Math.floor(span / DAY_MS)}d`;
  if (span < MONTH_MS) return `${Math.floor(span / WEEK_MS)}w`;
  return `${Math.floor(span / MONTH_MS)}mo`;
}

/** Whether a card has anything to open: a status, or an away message. */
export function hasStatus(entry: RosterEntry): boolean {
  const status = entry.user.status;
  if (entry.awayMessage !== null && entry.awayMessage !== "") return true;
  if (!status) return false;
  return [status.line, status.reading, status.listening, status.working_on].some(
    (field) => field !== null && field !== "",
  );
}
