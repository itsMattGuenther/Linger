/**
 * What the buddy list shows for one server, worked out from the store and
 * nothing else (docs/design/buddy-list.md, "The buddy list"). Pure, so the
 * list window draws it and the tests check it without either knowing about
 * the other.
 *
 * The order of the list is fixed by the design: you, then the rooms (the
 * activity view), then your DMs, then everyone on the server. People are not
 * grouped by room; where somebody is goes on their row as a small note.
 */
import type { PresenceState } from "../../generated/PresenceState";
import type { Room } from "../../generated/Room";
import type { RoomId } from "../../generated/RoomId";
import type { User } from "../../generated/User";
import { dmLabel, orderDms, peopleIn } from "../../lib/dm";
import { type GatewayState, hasNewActivity, voicePeersIn } from "../../lib/gateway";
import { occupantsOf } from "../../lib/occupancy";
import { buildRoster, type RosterEntry, shortAgo } from "../../lib/roster";

export interface ListModel {
  /** You, as the list's top card. Null until the server has said who you are. */
  me: MeCard | null;
  rooms: RoomRow[];
  dms: DmRow[];
  people: PeopleGroups;
}

export interface MeCard {
  user: User;
  state: PresenceState;
  /** Where you are, said plainly: "in #general", "around". */
  where: string;
}

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
}

/** Everyone but you, here first, then away, then offline (folded by default). */
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

  const dms = orderDms(state.dms, (room: Room) => hasNewActivity(state, room.id)).map(
    (room): DmRow => ({
      id: room.id,
      label: dmLabel(room, users, meId),
      people: peopleIn(room, users, meId).map((user) => ({ user, state: stateOf(user.id) })),
      memberIds: room.member_ids ?? [],
      fresh: hasNewActivity(state, room.id),
    }),
  );

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
    if (entry.isMe) {
      me = { user: entry.user, state: entry.state, where: noteFor(entry, now) };
      continue;
    }
    const row: PersonRow = {
      user: entry.user,
      state: entry.state,
      note: noteFor(entry, now),
      line: entry.awayMessage ?? entry.user.status?.line ?? null,
      inVoice: entry.inVoice,
    };
    if (entry.state === "away") people.away.push(row);
    else if (entry.state === "offline") people.offline.push(row);
    else people.here.push(row);
  }

  return { me, rooms, dms, people };
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
 * words. Null for you, or for somebody this server doesn't list.
 */
export function personRow(state: GatewayState, userId: string, now: number): PersonRow | null {
  const { people } = listModel(state, now);
  return [...people.here, ...people.away, ...people.offline].find((row) => row.user.id === userId) ?? null;
}
