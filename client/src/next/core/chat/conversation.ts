/**
 * What the chat window shows about each open conversation, read from a
 * server's store: the tab, the header, who's typing, who's in voice, and
 * where the conversation opens. Pure, so the window's wiring
 * (app/chat/ChatWindow.tsx) only joins these to the views.
 */
import type { MessageId } from "../../../generated/MessageId";
import type { PresenceState } from "../../../generated/PresenceState";
import type { Room } from "../../../generated/Room";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { dmLabel, peopleIn } from "../../../lib/dm";
import { type GatewayState, hasNewActivity, typistsIn, voicePeersIn } from "../../../lib/gateway";
import { occupantsOf } from "../../../lib/occupancy";
import { keyOf, type TabKey } from "../tabs";

/** A room or a DM you can see on this server, or null if there's none by that id. */
export function conversationIn(state: GatewayState, roomId: RoomId): Room | null {
  return state.rooms.find((room) => room.id === roomId && room.archived_at === null) ?? state.dms.find((dm) => dm.id === roomId) ?? null;
}

/** Where somebody is, as the list shows it: no entry means not connected. */
export function presenceOf(state: GatewayState, userId: string): PresenceState {
  return state.presence.find((entry) => entry.user_id === userId)?.state ?? "offline";
}

/** Who else is in a DM, with where they are. */
export function dmPeople(state: GatewayState, dm: Room): { user: User; state: PresenceState }[] {
  return peopleIn(dm, state.users, state.me?.id ?? null).map((user) => ({ user, state: presenceOf(state, user.id) }));
}

export interface TabModel {
  id: string;
  /** A room's name (the # is drawn), or who's in a DM. */
  title: string;
  /** "#general", or "DM with Jules". */
  label: string;
  /** A room leads with its #; a DM with one other person leads with their marker. */
  lead: { kind: "room" } | { kind: "person"; user: User; state: PresenceState } | null;
  /** Something new arrived and this tab isn't showing: bold, never a count. */
  fresh: boolean;
  voice: "mine" | "others" | null;
  speaking: boolean;
}

/**
 * One tab. `talking` is who is talking right now; only your own voice room
 * is heard, so only its tab can light up.
 */
export function tabModel(tab: TabKey, state: GatewayState, showing: boolean, talking: ReadonlySet<string>): TabModel | null {
  const room = conversationIn(state, tab.roomId);
  if (room === null) return null;
  const inVoice = voicePeersIn(state, room.id).map((peer) => peer.user_id);
  const mine = state.myVoice?.roomId === room.id;
  const dm = room.kind === "dm";
  const others = dm ? dmPeople(state, room) : [];
  const [only] = others;
  const title = dm ? dmLabel(room, state.users, state.me?.id ?? null) : room.name;
  return {
    id: keyOf(tab),
    title,
    label: dm ? `DM with ${title}` : `#${room.name}`,
    lead: !dm ? { kind: "room" } : others.length === 1 && only ? { kind: "person", user: only.user, state: only.state } : null,
    fresh: !showing && hasNewActivity(state, room.id),
    voice: mine ? "mine" : inVoice.length > 0 ? "others" : null,
    speaking: inVoice.some((id) => talking.has(id)),
  };
}

/** Who a room's header shows as in it: people, never a count of them. */
export function peopleInRoom(state: GatewayState, roomId: RoomId): User[] {
  return occupantsOf(roomId, state.occupancy, state.presence, state.users);
}

/** Who is writing here right now, not you (`typistsIn` leaves you out). */
export function typingIn(state: GatewayState, roomId: RoomId, now: number): User[] {
  const byId = new Map(state.users.map((user) => [user.id, user]));
  return typistsIn(state, roomId, now).flatMap((id) => byId.get(id) ?? []);
}

/** Who is in voice here, by user id, in the server's order. */
export function voiceHere(state: GatewayState, roomId: RoomId): string[] {
  return voicePeersIn(state, roomId).map((peer) => peer.user_id);
}

/**
 * Where a conversation opens (SPEC §4.2): on the "you left off here" line
 * when something arrived since you last read it, otherwise at the newest
 * message. Decided once per visit, after the read positions have arrived.
 */
export function openingAt(state: GatewayState, roomId: RoomId): MessageId | null {
  const marker = state.read[roomId];
  const newest = state.newest[roomId];
  return marker !== undefined && newest !== undefined && newest > marker ? marker : null;
}
