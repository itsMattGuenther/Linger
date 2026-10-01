/**
 * What the buddy list shows for one server, worked out from the store and
 * nothing else (docs/design/buddy-list.md, "The buddy list"). Pure, so the
 * list window draws it and the tests check it without either knowing about
 * the other.
 *
 * The order of the list is fixed by the design: you, then the rooms (the
 * activity view) with your group DMs after them, then everyone on the server.
 * People are not grouped by room; where somebody is goes on their row as a
 * small note. A one-to-one DM has no row of its own: it lives on its person
 * (#351), because the list holds places and people, and a DM with Jules is
 * Jules.
 */
import type { PresenceState } from "../../generated/PresenceState";
import type { MessageId } from "../../generated/MessageId";
import type { Room } from "../../generated/Room";
import type { RoomId } from "../../generated/RoomId";
import type { User } from "../../generated/User";
import { dmLabel, orderDms, others, peopleIn } from "../../lib/dm";
import { type GatewayState, hasNewActivity, voicePeersIn } from "../../lib/gateway";
import { occupantsOf } from "../../lib/occupancy";
import { buildRoster, type RosterEntry, shortAgo } from "../../lib/roster";

export interface ListModel {
  /** You, as the list's top card. Null until the server has said who you are. */
  me: MeCard | null;
  rooms: RoomRow[];
  /**
   * Group DMs, drawn with the rooms: a group DM is a small private room
   * (#351). A DM with one person the server no longer lists stays here too,
   * named as it was, since it has no person's row to live on.
   */
  groups: DmRow[];
  /** Every DM you're in, by who is in it, so the picker opens the one you have (SPEC §4.13). */
  dmMembers: { id: RoomId; member_ids: string[] }[];
  people: PeopleGroups;
}

/**
 * You, as a friend's list shows you: the same note ("in #general",
 * "around") and second line as anybody's row. The list draws it as its top
 * card, never among People, and your own card is opened from it (#271).
 */
export type MeCard = PersonRow;

export interface RoomRow {
  id: RoomId;
  name: string;
  /** Something arrived you have not read. Drawn as weight, never as a number. */
  fresh: boolean;
  /** Who is in the room, by name. */
  people: User[];
  /** Somebody has a microphone on in this room. */
  voice: boolean;
}

export interface DmRow {
  id: RoomId;
  /** Named by who else is in it (SPEC §4.13). */
  label: string;
  /** Everyone in it but you, with where they are, for the markers. */
  people: Present[];
  /** Everyone in it, you included, as the server lists them: the DM's identity (SPEC §4.13). */
  memberIds: string[];
  fresh: boolean;
}

/** A person and their presence, which is all a marker needs. */
export interface Present {
  user: User;
  state: PresenceState;
}

export interface PersonRow {
  user: User;
  state: PresenceState;
  /** The small note on the right: "in #general", "around", "last here 2d". */
  note: string;
  /** The second line: the away message when there is one, else the status line. */
  line: string | null;
  inVoice: boolean;
  /** Your one-to-one DM with them, when you have one: it lives on their row (#351). */
  dm: RoomId | null;
  /** They've written there and you haven't read it: the row is lit (#291, #351). */
  fresh: boolean;
}

/**
 * Everyone but you, here first, then away, then offline (folded by default).
 * In each, the people you're talking to come first (#351): whoever wrote to
 * you, then whoever you've talked with most recently, then everyone else in
 * the roster's order.
 */
export interface PeopleGroups {
  here: PersonRow[];
  away: PersonRow[];
  offline: PersonRow[];
}

export function listModel(state: GatewayState, now: number): ListModel {
  const meId = state.me?.id ?? null;
  const users = state.users;

  const rooms = state.rooms
    .filter((room) => room.archived_at === null)
    .sort((a, b) => a.position - b.position)
    .map(
      (room): RoomRow => ({
        id: room.id,
        name: room.name,
        fresh: hasNewActivity(state, room.id),
        people: occupantsOf(room.id, state.occupancy, state.presence, users),
        voice: voicePeersIn(state, room.id).length > 0,
      }),
    );

  const presenceOf = new Map(state.presence.map((entry) => [entry.user_id, entry.state]));
  // No entry means the server isn't tracking them, and it tracks only
  // connected clients: absent is offline (the same rule as the roster).
  const stateOf = (id: string): PresenceState => presenceOf.get(id) ?? "offline";

  // A DM with exactly one other person the server lists is that person's;
  // every other DM is a group, drawn with the rooms (#351).
  const listed = new Set(users.map((user) => user.id));
  const oneToOne = new Map<string, Room>();
  const groupDms: Room[] = [];
  for (const room of state.dms) {
    const [other, ...rest] = others(room, meId);
    if (other !== undefined && rest.length === 0 && listed.has(other) && !oneToOne.has(other)) oneToOne.set(other, room);
    else groupDms.push(room);
  }
  const groups = orderDms(groupDms, (room: Room) => hasNewActivity(state, room.id), state.newest).map(
    (room): DmRow => ({
      id: room.id,
      label: dmLabel(room, users, meId),
      people: peopleIn(room, users, meId).map((user) => ({ user, state: stateOf(user.id) })),
      memberIds: room.member_ids ?? [],
      fresh: hasNewActivity(state, room.id),
    }),
  );
  // When you last talked, by the newest message either way; nothing said yet
  // is not talking. Ids are UUIDv7, so comparing them compares times (lib/dm).
  const talkedAt = (room: Room | undefined): MessageId | null =>
    room === undefined ? null : (state.newest[room.id] ?? room.last_message_id ?? null);

  const inVoice = new Set(Object.values(state.voice).flatMap((peers) => peers.map((peer) => peer.user_id)));
  const roster = buildRoster({
    users,
    presence: state.presence,
    rooms: state.rooms,
    meId,
    offlineAt: state.offlineAt,
    now,
    inVoice,
  });

  const people: PeopleGroups = { here: [], away: [], offline: [] };
  let me: MeCard | null = null;
  for (const entry of roster) {
    const dm = oneToOne.get(entry.user.id);
    const row: PersonRow = {
      user: entry.user,
      state: entry.state,
      note: noteFor(entry, now),
      line: entry.awayMessage ?? entry.user.status?.line ?? null,
      inVoice: entry.inVoice,
      dm: dm?.id ?? null,
      fresh: dm !== undefined && hasNewActivity(state, dm.id),
    };
    if (entry.isMe) me = row;
    else if (entry.state === "away") people.away.push(row);
    else if (entry.state === "offline") people.offline.push(row);
    else people.here.push(row);
  }

  const talking = (rows: PersonRow[]) => talkingFirst(rows, (row) => talkedAt(oneToOne.get(row.user.id)));
  return {
    me,
    rooms,
    groups,
    dmMembers: state.dms.map((room) => ({ id: room.id, member_ids: room.member_ids ?? [] })),
    people: { here: talking(people.here), away: talking(people.away), offline: talking(people.offline) },
  };
}

/**
 * One group of people with the ones you're talking to first (#351): whoever
 * wrote something you haven't read, then whoever you've talked with, newest
 * first, then everyone else in the order they came. So on a big server the
 * people you DM stay at the top instead of sinking among everybody else.
 * No count and no ordering by how much is unread (SPEC §4.2): a person has
 * something new or not.
 */
export function talkingFirst(rows: readonly PersonRow[], talkedAt: (row: PersonRow) => string | null): PersonRow[] {
  const rank = (row: PersonRow) => (row.fresh ? 0 : talkedAt(row) !== null ? 1 : 2);
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const at = talkedAt(a);
    const bt = talkedAt(b);
    if (at === null || bt === null || at === bt) return 0;
    return at < bt ? 1 : -1;
  });
}

/** A DM you're in has something you haven't read, on a person's row or a group's. */
export function anyDmFresh(model: ListModel): boolean {
  const { here, away, offline } = model.people;
  return model.groups.some((group) => group.fresh) || [...here, ...away, ...offline].some((row) => row.fresh);
}

/**
 * Where somebody is, in the fewest plain words. Being in a DM is being
 * around (SPEC §4.13, decided 2026-09-26): a server from 0.4.1 on says so
 * itself, and an older one's in-room entry with no room we hold (or a DM we
 * are in) reads the same way here, never "in a room".
 */
function noteFor(entry: RosterEntry, now: number): string {
  switch (entry.state) {
    case "in_room":
      return entry.room === null ? "around" : `in #${entry.room.name}`;
    case "around":
      return "around";
    case "idle":
      return "idle";
    case "away":
      return "away";
    case "offline":
      return entry.seenAt === null ? "offline" : `last here ${shortAgo(entry.seenAt, now)}`;
  }
}

/**
 * One person as their row in the list shows them, for their card opened from
 * anywhere else (a name in a conversation, PPL-6): the same note, the same
 * words. You too, as the top card has you, so your own name opens your card
 * as friends see it (#271). Null for somebody this server doesn't list.
 */
export function personRow(state: GatewayState, userId: string, now: number): PersonRow | null {
  const { me, people } = listModel(state, now);
  if (me?.user.id === userId) return me;
  return [...people.here, ...people.away, ...people.offline].find((row) => row.user.id === userId) ?? null;
}

/** How many rooms a server's list shows before the quiet ones fold away (decision 22). */
export const ROOMS_SHOWN = 8;

/**
 * A long room list, split (decision 22): past eight rooms, the ones with
 * nobody in them, no voice and nothing new fold under "More rooms". Rooms
 * with something going on always show, and quiet ones fill the list up to
 * eight in the host's order. Both halves keep the host's order.
 */
export function splitRooms(rooms: readonly RoomRow[], limit = ROOMS_SHOWN): { shown: RoomRow[]; more: RoomRow[] } {
  if (rooms.length <= limit) return { shown: [...rooms], more: [] };
  const busy = (room: RoomRow) => room.fresh || room.voice || room.people.length > 0;
  let roomForQuiet = Math.max(0, limit - rooms.filter(busy).length);
  const shown: RoomRow[] = [];
  const more: RoomRow[] = [];
  for (const room of rooms) {
    if (busy(room)) shown.push(room);
    else if (roomForQuiet > 0) {
      shown.push(room);
      roomForQuiet -= 1;
    } else more.push(room);
  }
  return { shown, more };
}

