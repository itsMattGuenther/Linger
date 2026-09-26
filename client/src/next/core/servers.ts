/**
 * The buddy list with several servers (docs/design/buddy-list.md, "Several
 * servers"; parity MULTI-1…9): what each server's header says, worked out
 * from its store and its list model. Pure, so every case is tested without
 * a window.
 *
 * A folded server still shows its lights: its name (bold when something
 * inside is new, never while it's Quiet), the dots of who's on, and one plain
 * line about what's happening there. None of it is a number (SPEC §4.2).
 *
 * Not here yet: "4:52 AM there". The host's time zone needs a server setting
 * and a protocol field (parity decision 3).
 */
import type { PresenceState } from "../../generated/PresenceState";
import type { User } from "../../generated/User";
import { type GatewayState, voicePeersIn } from "../../lib/gateway";
import type { ListModel, PersonRow, Present } from "./list";

/** `linger-core::limits::MAX_VOICE_PEERS`: voice holds eight a room. */
export const MAX_VOICE_PEERS = 8;

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"] as const;

/**
 * How full a voice room is, in words, and only when it's nearly full: a
 * number on every voice room would be a counter.
 */
export function seatsWords(inVoice: number): string | null {
  if (inVoice >= MAX_VOICE_PEERS) return "full";
  const left = MAX_VOICE_PEERS - inVoice;
  return left <= 2 ? `room for ${WORDS[left] ?? "no"} more` : null;
}

/** A folded server's one line. Names are users, so the list draws them in their own faces. */
export type FoldedLine =
  /** Somebody is talking in a room: up to two by name, or just the room when it's more. */
  | { kind: "voice"; room: string; people: User[]; seats: string | null }
  /** Nobody's talking, but people are in a room: up to two by name. */
  | { kind: "room"; room: string; people: User[]; more: boolean }
  /** Nobody's in a room. Who's up, if anybody. */
  | { kind: "quiet"; up: User[]; more: boolean };

/** An open server's line: who you are there, and your status or away message there. */
export interface OpenLine {
  me: User;
  /** Your away message there, when you're away there. */
  away: string | null;
  status: string | null;
}

export interface ServerHeader {
  /** Something inside is new. Weight only, and never while the server is Quiet. */
  fresh: boolean;
  /** Who's on: in voice, then in a room, then around, then away. Offline isn't on. */
  dots: Present[];
  folded: FoldedLine;
  /** Null until the server has said who you are. */
  open: OpenLine | null;
}

const RANK: Record<PresenceState, number> = { in_room: 1, around: 2, idle: 2, away: 3, offline: 4 };

/** Everyone on, most present first; the list's own order within each kind. */
function dotsOf(model: ListModel): Present[] {
  const on: PersonRow[] = [...model.people.here, ...model.people.away];
  const rank = (row: PersonRow) => (row.inVoice ? 0 : RANK[row.state]);
  return on
    .map((row, at) => ({ row, at }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at)
    .map(({ row }) => ({ user: row.user, state: row.state }));
}

function foldedOf(state: GatewayState, model: ListModel): FoldedLine {
  const meId = state.me?.id ?? null;
  const byId = new Map(state.users.map((user) => [user.id, user]));

  // Someone talking, in the first room (in list order) where somebody else is.
  for (const room of model.rooms) {
    const ids = [...new Set(voicePeersIn(state, room.id).map((peer) => peer.user_id))];
    const others = ids.filter((id) => id !== meId).flatMap((id) => byId.get(id) ?? []);
    if (others.length === 0) continue;
    return { kind: "voice", room: room.name, people: others.length <= 2 ? others : [], seats: seatsWords(ids.length) };
  }

  // People in a room: the first room (in list order) with somebody in it.
  for (const room of model.rooms) {
    const inIt = room.people.filter((user) => user.id !== meId);
    if (inIt.length === 0) continue;
    return { kind: "room", room: room.name, people: inIt.slice(0, 2), more: inIt.length > 2 };
  }

  const up = model.people.here.filter((row) => row.state === "around" || row.state === "idle").map((row) => row.user);
  return { kind: "quiet", up: up.slice(0, 2), more: up.length > 2 };
}

/** What a server's header and the line under it say. */
export function serverHeader(state: GatewayState, model: ListModel, quiet: boolean): ServerHeader {
  const fresh = !quiet && (model.rooms.some((room) => room.fresh) || model.dms.some((dm) => dm.fresh));
  const me = model.me;
  const awayMessage = me?.user.status?.away_message ?? null;
  return {
    fresh,
    dots: dotsOf(model),
    folded: foldedOf(state, model),
    open: me
      ? {
          me: me.user,
          away: awayMessage !== null && awayMessage !== "" ? awayMessage : null,
          status: me.user.status?.line ?? null,
        }
      : null,
  };
}

/** "Eli", "Eli and Jules", "Eli, Jules and others". */
export function namesText(people: readonly User[], more: boolean): string {
  const names = people.map((person) => person.display_name);
  const [first, second] = names;
  if (first === undefined) return "";
  if (second === undefined) return more ? `${first} and others` : first;
  return more ? `${first}, ${second} and others` : `${first} and ${second}`;
}

/** The folded line in plain words, for assistive technology and tests. */
export function foldedText(line: FoldedLine): string {
  switch (line.kind) {
    case "voice": {
      const lead = line.people.length > 0 ? `${namesText(line.people, false)} in #${line.room}` : `#${line.room} in voice`;
      return line.seats ? `${lead} · ${line.seats}` : lead;
    }
    case "room":
      return `${namesText(line.people, line.more)} in #${line.room}`;
    case "quiet": {
      if (line.up.length === 0) return "quiet";
      const who = namesText(line.up, line.more);
      return line.up.length === 1 && !line.more ? `quiet · ${who}'s up` : `quiet · ${who} are up`;
    }
  }
}

/** The open line in plain words. */
export function openText(line: OpenLine): string {
  const lead = `you're ${line.me.display_name} here`;
  if (line.away !== null) return `${lead} · “${line.away}”`;
  return line.status ? `${lead} · ${line.status}` : lead;
}

/** Where you're away, of your servers, in your order. */
export function awayOn<T extends { id: string; model: ListModel }>(servers: readonly T[]): string[] {
  return servers
    .filter((server) => {
      const message = server.model.me?.user.status?.away_message ?? null;
      return message !== null && message !== "";
    })
    .map((server) => server.id);
}

/** "The Good Company", "The Good Company and Ashen Lanterns", "A, B and C". */
export function serverNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/**
 * Move a server past the next one shown, up or down, when only some of your
 * servers are shown (Settings leaves out one it can't draw yet): the two swap
 * places in your whole order, and the rest stay exactly where they were.
 */
export function moveShown(order: readonly string[], shown: readonly string[], id: string, by: -1 | 1): string[] {
  const other = shown[shown.indexOf(id) + by];
  const at = order.indexOf(id);
  const to = other === undefined ? -1 : order.indexOf(other);
  if (!shown.includes(id) || at === -1 || to === -1 || other === undefined) return [...order];
  const next = [...order];
  next[at] = other;
  next[to] = id;
  return next;
}

/** Move a server one place up or down in your order. Nothing moves past an end. */
export function moveServer(order: readonly string[], id: string, by: -1 | 1): string[] {
  const at = order.indexOf(id);
  const to = at + by;
  if (at === -1 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next[at] = next[to] ?? id;
  next[to] = id;
  return next;
}
