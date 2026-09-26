/**
 * The gateway store: the frontend's one piece of shared state.
 *
 * AGENTS allows local component state plus exactly one gateway store, and this
 * is it — subscribe-and-notify instead of a state library. React reads it
 * through `useSyncExternalStore`, so every component that cares re-renders on a
 * change and nothing else does.
 *
 * The connection itself is not here. It lives in the Tauri core
 * (ARCHITECTURE §1), which owns reconnecting, resume and sequence numbers and
 * sends two events up: a connection status, and each sequenced server frame.
 * This file folds those frames into a snapshot the UI can render, answers when
 * the core says it needs a fresh access token, and holds each open room's
 * history — because history arrives two ways, as pages over REST and as frames
 * over the socket, and the two have to be stitched together in one place.
 *
 * **One snapshot per server, keyed by base URL (T-412).** The client can be
 * signed into several servers at once, and each one has its own rooms, its own
 * people and its own read markers. Nothing is shared between them: a room id
 * only means anything next to the server it came from. The core tags every
 * event it sends up with the server it belongs to, and every function here
 * either takes that server's `AuthedApi` or the base URL itself.
 *
 * Running `pnpm dev` in a plain browser, with no Tauri underneath, leaves the
 * status on `offline` — the same honest degrading as session storage.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import type { ClientFrame } from "../generated/ClientFrame";
import type { Attachment } from "../generated/Attachment";
import type { CreateMessageRequest } from "../generated/CreateMessageRequest";
import type { EditMessageRequest } from "../generated/EditMessageRequest";
import type { Message } from "../generated/Message";
import type { MessageId } from "../generated/MessageId";
import type { NotifyRule } from "../generated/NotifyRule";
import type { PresenceEntry } from "../generated/PresenceEntry";
import type { PresenceState } from "../generated/PresenceState";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { ServerFrame } from "../generated/ServerFrame";
import type { UpdateMeRequest } from "../generated/UpdateMeRequest";
import type { UpdateReadMarkerRequest } from "../generated/UpdateReadMarkerRequest";
import type { User } from "../generated/User";
import type { UserStatus } from "../generated/UserStatus";
import type { UserId } from "../generated/UserId";
import { considerFrame } from "./notify";
import {
  type VoiceDeviceChoice,
  voiceFrame,
  voiceJoin,
  voiceLeave,
  voiceControls,
  voiceVolume,
} from "./ipc";
import type { IceServers } from "../generated/IceServers";
import type { VoicePeer } from "../generated/VoicePeer";
import { playKnock, playSound } from "./sound";
import { voiceCue } from "./sound-events";
import { clampVolume, loadVoiceVolumes, saveVoiceVolume } from "./voice";
import type { AuthedApi } from "./api";
import { START, advance, type Position } from "./catchup";

/**
 * Mirrors `Status` in `src-tauri/src/gateway.rs`. Allowed to be hand-written:
 * AGENTS rule 7 covers types that cross the *wire*, and this one never leaves
 * the machine. A Rust test pins the `kind` spellings so the halves can't drift.
 */
export type GatewayStatus =
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "connected"; tls: boolean }
  | { kind: "identifying" }
  | { kind: "resuming" }
  | { kind: "ready"; latency_ms: number }
  | { kind: "waiting"; retry_in_ms: number; reason: string }
  | { kind: "needs_token" };

/**
 * One room's loaded history.
 *
 * A room only appears in the store once it has been opened. Message frames for
 * a room nobody has opened are dropped rather than kept, because the page fetch
 * that opens it would fetch them anyway, and half a room's history is worse
 * than none: the gaps are invisible.
 */
export interface RoomStream {
  /** Oldest first. Ids are UUIDv7, so "in id order" is "in time order". */
  messages: Message[];
  /** True once the oldest message held is the oldest the server has. */
  atStart: boolean;
  /**
   * True when the newest message held is the newest the server has — which is
   * every room the ordinary way in, and *not* a room opened on a search hit
   * six months back (`openAround`).
   *
   * It is what makes a detached window safe. A live `message.create` folded
   * into a window that stops in February would sit next to a message from
   * eight months earlier with nothing between them and nothing to say so, and
   * an invisible gap is worse than a message that arrives when you scroll back
   * down to where it belongs. So frames are dropped while this is false, and
   * `loadNewer` reads forwards until the room is whole again.
   */
  atEnd: boolean;
  /** A page is in flight; stops the same backfill firing twice. */
  loading: boolean;
  /**
   * Sends still waiting on the server, shown in the room the instant Enter is
   * pressed rather than after the round trip (issue #128). Never merged into
   * `messages` — that list stays exactly what the server has confirmed, which
   * is what every other reader of it (search, export, resume) depends on.
   */
  pending: PendingSend[];
}

/** One not-yet-confirmed send, kept next to its room. */
export interface PendingSend {
  /** Ties this entry to the `sendMessage` call that is still waiting on it. */
  key: number;
  /** A stand-in `Message`, built from what the composer already knows and
   *  given a made-up id so it can never collide with a real one. */
  message: Message;
}

export interface GatewayState {
  status: GatewayStatus;
  /** Who the server says we are. Null until the first `ready`. */
  me: User | null;
  users: User[];
  /** The server's rooms — the same list for everybody. */
  rooms: Room[];
  /**
   * The DMs you are in (SPEC §4.13), which is a different list for every
   * person on the server.
   *
   * Kept apart from `rooms` because the wire keeps them apart, and the wire
   * keeps them apart so that a surface drawing the server's rooms cannot draw
   * somebody's private conversation by forgetting a filter. Mixing them here
   * and filtering at each drawing site would hand that mistake straight back.
   */
  dms: Room[];
  presence: PresenceEntry[];
  /** Who is in each room, keyed by room id. */
  occupancy: Record<string, UserId[]>;
  /** Loaded history, keyed by room id. */
  streams: Record<string, RoomStream>;
  /**
   * Who is typing where: room id → user id → when they last said so. Kept as a
   * moment rather than a boolean because nobody sends a "stopped" — the signal
   * simply goes stale, and `typistsIn` is what decides when.
   */
  typing: Record<string, Record<string, number>>;
  /**
   * Room id → the newest message you have read, as far as the server knows.
   *
   * This is a *position*, never a quantity. Nothing in this file, and nothing
   * downstream of it, subtracts two of these to get a number — SPEC §4.2 is the
   * whole point of the app and a count is the thing it refuses to have.
   */
  read: Record<string, MessageId>;
  /** Initial marker fetch settled; opening a room must wait before marking it read. */
  readLoaded: boolean;
  /**
   * Room id → the newest message that exists. Seeded from `ready` and kept up
   * to date by `message.create`, because the server computes a room's
   * `last_message_id` when it is asked for and never pushes a new one.
   *
   * Compared against `read`, this is the whole of the label-weight change: a
   * room either has something in it you have not seen, or it does not.
   */
  newest: Record<string, MessageId>;
  /**
   * Room id → the message the "you left off here" line sits after.
   *
   * Pinned the first time you open the room in this run of the app and then
   * left alone, even as you read past it. That is SPEC §4.2's "persists until
   * scrolled past and stays visible for the rest of the session": a line that
   * moved while you were reading would be a line you could never use to find
   * your way back to where you started.
   */
  leftOff: Record<string, MessageId>;
  /** "Always notify me when this person posts" (SPEC §4.2). */
  notifyRules: NotifyRule[];
  /**
   * User id → when this client watched their connection go away.
   *
   * The roster says how long somebody has been gone, and the server is no help
   * for the people who left while we were watching: it writes `last_seen_at` on
   * disconnect and never pushes the new value. Our own observation is the
   * fresher of the two, so it is kept. A fresh `ready` throws it away, because
   * the users it carries are freshly read from the database.
   */
  offlineAt: Record<string, number>;
  /**
   * Knocks that have not faded yet (SPEC §4.9, T-1102).
   *
   * The one piece of this snapshot that is *not* a copy of something the
   * server is holding: a knock is not stored at either end, so this list is
   * the only place it exists, and it is empty again a few seconds later.
   *
   * It is a list rather than a set of user ids because two knocks from the same
   * person are two knocks. Nothing counts them, nothing keeps them, and nothing
   * shows them after they have gone — SPEC §4.9 is emphatic that a knock which
   * leaves something sitting there has become a message.
   */
  knocks: Knock[];
  /**
   * This connection's session id, from `ready`. Voice is keyed by session
   * (PROTOCOL §8: a peer is a client, not a person), so joining needs it.
   */
  sessionId: string | null;
  /**
   * Who is in voice, per room: the server's whole list every time
   * (`voice.state` is a snapshot, never a delta). A room with nobody in
   * voice has no entry. Filtered by the server before it gets here, so a
   * DM's voice never reaches a non-member.
   */
  voice: Record<string, VoicePeer[]>;
  /**
   * Our own seat, while we have one. Local state: the server knows we are
   * in voice and our self-reported controls. Device health, speaking levels
   * and per-person volume remain local (SPEC §4.14).
   */
  myVoice: MyVoice | null;
}

/** Everything about being in voice that is this client's alone. */
export interface MyVoice {
  roomId: RoomId;
  /** Sending silence. Yours; nobody else can set it. */
  muted: boolean;
  deafened: boolean;
  /** Mic choice to restore after deafen; push-to-talk restores closed. */
  mutedBeforeDeafen: boolean;
  pushToTalk: boolean;
  moved: boolean;
  /**
   * What the core says the microphone is doing: `opening` until the
   * devices are open, `sending` while frames flow, `stopped` if the device
   * went away mid-call (T-1405 will make that recover).
   */
  audio: string;
  /** Peer session id → its connection state, as the core reports it. */
  peers: Record<string, string>;
  /** Peer session id → whether they are talking right now. */
  speaking: Record<string, boolean>;
  /** Whether *we* are — what the microphone is sending, after mute. */
  talking: boolean;
  /** Peer session id → how loud they play for us. 1 is as sent. */
  volumes: Record<string, number>;
}

/** One knock, on its way to a card that fades. `id` is local to this client:
 *  the wire carries no id, because there is nothing to refer back to. */
export interface Knock {
  id: string;
  from: UserId;
  /** When it arrived, by this machine's clock. */
  at: number;
}

/**
 * How long a knock's card stays before it goes on its own.
 *
 * Long enough to look up and see who it was, short enough that it is gone
 * before it becomes something you have to deal with. There is no dismiss
 * button, so this number is the entire lifetime of the thing.
 */
export const KNOCK_TTL_MS = 8_000;

/** Ids for knock cards that arrive without a sequence number, which a
 *  knock never should: the ones that do are named by it (see `apply`). */
let knockSeq = 0;

/** Ids for pending sends, the same way — local only, never sent anywhere. */
let pendingSeq = 0;

const EMPTY: GatewayState = {
  status: { kind: "offline" },
  me: null,
  users: [],
  rooms: [],
  dms: [],
  presence: [],
  occupancy: {},
  streams: {},
  typing: {},
  read: {},
  readLoaded: false,
  newest: {},
  leftOff: {},
  notifyRules: [],
  offlineAt: {},
  knocks: [],
  sessionId: null,
  voice: {},
  myVoice: null,
};

/**
 * Every server's snapshot, keyed by base URL. Replaced rather than mutated, so
 * `useSyncExternalStore` sees a new object exactly when something changed.
 */
let states: Record<string, GatewayState> = {};
const listeners = new Set<() => void>();

function announce(): void {
  for (const notify of listeners) notify();
}

/** One server's snapshot. A server we have never connected to reads as empty,
 *  which is what lets a component render before its connection is up. */
function stateOf(server: string): GatewayState {
  return states[server] ?? EMPTY;
}

function publish(server: string, next: GatewayState): void {
  states = { ...states, [server]: next };
  announce();
}

function forget(server: string): void {
  if (!(server in states)) return;
  const next = { ...states };
  delete next[server];
  states = next;
  announce();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Subscribe a component to one server's gateway. */
export function useGateway(server: string): GatewayState {
  return useSyncExternalStore(subscribe, () => stateOf(server));
}

/** One server's snapshot, outside React. The hook above is the door for
 *  components; this is the same read for anything that is not one. */
export function serverState(server: string): GatewayState {
  return stateOf(server);
}

/** Subscribe to every server at once. The rail is the only caller: it draws a
 *  dot per server and needs all of them, not one. */
export function useServers(): Record<string, GatewayState> {
  return useSyncExternalStore(subscribe, () => states);
}

/**
 * True when this server is holding something you have not read, in any room.
 *
 * Still a boolean, still not a count (SPEC §4.2, AGENTS rule 3). It is the
 * server-rail half of the same signal the room list already draws: a server you
 * are not looking at gets a mark, never a number.
 */
export function anyNewActivity(current: GatewayState): boolean {
  return [...current.rooms, ...current.dms].some(
    (room) => room.archived_at === null && hasNewActivity(current, room.id),
  );
}

// ---------------------------------------------------------------------------
// Folding frames into the snapshot
// ---------------------------------------------------------------------------

/** Replace an entry keyed by id, or append it if it's new. */
function upsert<T>(list: T[], item: T, sameAs: (candidate: T) => boolean): T[] {
  const at = list.findIndex(sameAs);
  if (at < 0) return [...list, item];
  const next = [...list];
  next[at] = item;
  return next;
}

/** The newest message in each room, as `ready` describes them. */
function newestFrom(rooms: Room[]): Record<string, MessageId> {
  const newest: Record<string, MessageId> = {};
  for (const room of rooms) {
    if (room.last_message_id !== null) newest[room.id] = room.last_message_id;
  }
  return newest;
}

function occupancyFrom(presence: PresenceEntry[]): Record<string, UserId[]> {
  const rooms: Record<string, UserId[]> = {};
  for (const entry of presence) {
    if (entry.room_id === null) continue;
    (rooms[entry.room_id] ??= []).push(entry.user_id);
  }
  return rooms;
}

/**
 * Move one person in the occupancy map to match their presence. Presence
 * and occupancy frames arrive a beat apart, so rebuilding the *whole* map
 * from presence would drop anyone whose occupancy we have already seen and
 * whose presence we have not.
 */
function occupancyWith(
  occupancy: Record<string, UserId[]>,
  entry: PresenceEntry,
): Record<string, UserId[]> {
  let changed = false;
  const next: Record<string, UserId[]> = {};
  for (const [roomId, ids] of Object.entries(occupancy)) {
    if (!ids.includes(entry.user_id)) {
      next[roomId] = ids;
      continue;
    }
    changed = true;
    const without = ids.filter((id) => id !== entry.user_id);
    if (without.length > 0) next[roomId] = without;
  }
  if (entry.room_id !== null) {
    const held = next[entry.room_id] ?? [];
    if (!held.includes(entry.user_id)) {
      next[entry.room_id] = [...held, entry.user_id];
      changed = true;
    }
  }
  return changed ? next : occupancy;
}

/**
 * Keep `offlineAt` in step with one presence change. Pure, and separate,
 * because "when did they go" is the only thing on a roster card the server
 * does not tell us outright.
 */
function markOffline(
  held: Record<string, number>,
  userId: UserId,
  was: PresenceState,
  now: PresenceState,
): Record<string, number> {
  if (now === "offline") {
    if (was === "offline") return held;
    return { ...held, [userId]: Date.now() };
  }
  if (held[userId] === undefined) return held;
  const next = { ...held };
  delete next[userId];
  return next;
}

/**
 * How many messages one page of history holds. The server clamps `limit` to
 * 100 (PROTOCOL §4), so this is as much as one round trip can ever bring.
 */
const PAGE_SIZE = 100;

function byId(a: Message, b: Message): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** Insert or replace one message, keeping the list in id order. */
function mergeMessage(list: Message[], message: Message): Message[] {
  const at = list.findIndex((held) => held.id === message.id);
  if (at >= 0) {
    const next = [...list];
    next[at] = message;
    return next;
  }
  const newest = list[list.length - 1];
  // Nearly always: something newer than everything we hold.
  if (newest === undefined || newest.id < message.id) return [...list, message];
  return [...list, message].sort(byId);
}

/**
 * Whether a confirmed message is the one a still-open send was waiting for.
 *
 * There is no id the two share — a stand-in's id is made up locally, and the
 * server never sees it — so this matches on what was actually said. That is
 * enough to catch the one race there is: the server's live announcement of a
 * new message reaching this client before that message's own send call gets
 * its answer back (`sendMessage` below). Whichever arrives first clears the
 * stand-in; the other is then a no-op.
 */
function matchesPending(pending: Message, confirmed: Message): boolean {
  return (
    pending.room_id === confirmed.room_id &&
    pending.author_id === confirmed.author_id &&
    pending.body === confirmed.body &&
    pending.reply_to === confirmed.reply_to &&
    pending.attachments.length === confirmed.attachments.length &&
    pending.attachments.every((one, index) => one.id === confirmed.attachments[index]?.id)
  );
}

/** Fold a fetched page (the server sends newest-first) into what we hold. */
function mergePage(list: Message[], page: Message[]): Message[] {
  if (page.length === 0) return list;
  const older = [...page].sort(byId);
  const first = list[0];
  const last = older[older.length - 1];
  // Backfill asks for everything `before` the oldest message we hold, so the
  // ordinary case is a block that belongs entirely above the list. The slow
  // path is for the one race there is: a message arriving over the socket
  // while the first page of the same room is still on the wire.
  if (first === undefined || last === undefined || last.id < first.id) {
    return [...older, ...list];
  }
  const byKey = new Map(list.map((held) => [held.id, held]));
  for (const message of older) byKey.set(message.id, message);
  return [...byKey.values()].sort(byId);
}

/**
 * Rewrite one room's stream inside a snapshot. Returning the stream unchanged
 * returns the snapshot unchanged, so a frame that touches nothing re-renders
 * nothing.
 */
function withStream(
  current: GatewayState,
  roomId: RoomId,
  change: (stream: RoomStream) => RoomStream,
): GatewayState {
  const stream = current.streams[roomId];
  if (!stream) return current;
  const next = change(stream);
  if (next === stream) return current;
  return { ...current, streams: { ...current.streams, [roomId]: next } };
}

/** Forget that somebody was typing in a room. */
function stoppedTyping(current: GatewayState, roomId: RoomId, userId: UserId): GatewayState {
  const room = current.typing[roomId];
  if (!room || room[userId] === undefined) return current;
  const next = { ...room };
  delete next[userId];
  return { ...current, typing: { ...current.typing, [roomId]: next } };
}

/**
 * Apply one server frame. Pure, and exported because every window of the
 * Buddy list client folds the same frames with it (docs/design/architecture.md).
 */
export function apply(current: GatewayState, frame: ServerFrame): GatewayState {
  switch (frame.op) {
    case "ready":
      // A fresh `ready` replaces everything. It arrives after a re-identify,
      // which is exactly when our copy is the thing that can't be trusted.
      // Loaded history goes with it: re-identifying means the resume window
      // lapsed, so there may be messages we never saw, and a hole in the middle
      // of a room is invisible in a way an empty room is not. The open room
      // refetches, which costs one request and a scroll position.
      return {
        ...current,
        me: frame.d.user,
        users: frame.d.users,
        rooms: frame.d.rooms,
        dms: frame.d.dms,
        presence: frame.d.presence,
        occupancy: occupancyFrom(frame.d.presence),
        streams: {},
        typing: {},
        offlineAt: {},
        // A knock is a tap on the shoulder. One that was on screen before the
        // connection dropped has stopped meaning anything by the time we are
        // back, so it goes with the rest of the transient state.
        knocks: [],
        // A fresh `ready` is a fresh session, and a voice seat belongs to a
        // session (PROTOCOL §8): the old one is gone at the server, so it
        // goes here too. Seed visible rooms without opening our microphone.
        sessionId: frame.d.session_id,
        voice: Object.fromEntries((frame.d.voice ?? []).map((room) => [room.room_id, room.peers])),
        myVoice: null,
        // `read` and `leftOff` survive: one is a copy of something the server
        // is holding for us, and the other is where this session started, which
        // a reconnect does not change.
        newest: newestFrom([...frame.d.rooms, ...frame.d.dms]),
      };
    case "voice.state": {
      // The whole list, every time (PROTOCOL §8). An empty one is nobody,
      // and nobody is no entry rather than an empty entry, so "is anybody in
      // voice here" is one lookup.
      const { room_id, peers } = frame.d;
      const voice = { ...current.voice };
      if (peers.length === 0) delete voice[room_id];
      else voice[room_id] = peers;
      // If we thought we had a seat in this room and the server's list does
      // not have our session in it, we do not. The server ends a seat when a
      // session does (a lapsed resume window, say), and the core is told to
      // let go by the listener that folds this frame.
      const mine = current.myVoice;
      const seated =
        mine === null ||
        mine.roomId !== room_id ||
        peers.some((peer) => peer.session_id === current.sessionId);
      return { ...current, voice, myVoice: seated ? mine : null };
    }
    case "presence.update": {
      const entry = frame.d;
      const was = current.presence.find((p) => p.user_id === entry.user_id)?.state ?? "offline";
      const presence = upsert(current.presence, entry, (p) => p.user_id === entry.user_id);
      return {
        ...current,
        presence,
        // Occupancy frames arrive a beat earlier. Fold this person into
        // the map without rebuilding it, so someone whose occupancy we
        // already have is not dropped while theirs is still on the wire.
        occupancy: occupancyWith(current.occupancy, entry),
        // Note the moment somebody drops off, and forget it when they come
        // back. Only the *transition* sets it: a second offline frame for
        // somebody already gone must not restart their clock.
        offlineAt: markOffline(current.offlineAt, entry.user_id, was, entry.state),
      };
    }
    case "user.update": {
      const user = frame.d;
      // `upsert` appends when the id is unknown, which is what makes this frame
      // do double duty: it is "their name changed" and "here is somebody you
      // did not have" — a person who just registered, or a member the host let
      // back in (PROTOCOL §8).
      return {
        ...current,
        me: current.me?.id === user.id ? user : current.me,
        users: upsert(current.users, user, (u) => u.id === user.id),
      };
    }
    case "user.remove": {
      // The host removed them (T-413). The roster is built by mapping over
      // `users`, so dropping them here is the whole of the card going away.
      // Their presence goes too: an entry for somebody nobody can draw is a
      // row of state that outlives the person it describes.
      const { user_id } = frame.d;
      if (!current.users.some((u) => u.id === user_id)) return current;
      const offlineAt = { ...current.offlineAt };
      delete offlineAt[user_id];
      return {
        ...current,
        users: current.users.filter((u) => u.id !== user_id),
        presence: current.presence.filter((p) => p.user_id !== user_id),
        offlineAt,
      };
    }
    case "room.create":
    case "room.update": {
      const room = frame.d;
      // Which list it belongs in is the room's own answer, not the frame's.
      // A DM's `room.create` only ever reaches its members (PROTOCOL §8), so
      // arriving here at all means this one is ours — but it still goes in the
      // list for its kind, because `rooms` is what the rail draws as the
      // server's rooms and a DM is not one of them.
      const same = (r: Room): boolean => r.id === room.id;
      return room.kind === "dm"
        ? { ...current, dms: upsert(current.dms, room, same) }
        : { ...current, rooms: upsert(current.rooms, room, same) };
    }
    case "room.occupancy":
      return {
        ...current,
        occupancy: { ...current.occupancy, [frame.d.room_id]: frame.d.user_ids },
      };
    case "message.create":
    case "message.update": {
      const message = frame.d;
      let next = withStream(current, message.room_id, (stream) => {
        // A room showing a historical window (a search hit, `openAround`) is
        // not at the newest message, so a new one does not join onto what it
        // holds — folding it in would put August next to February with nothing
        // between them and nothing to say so. It is dropped, the same way a
        // frame for a room nobody has opened is, and reading forwards
        // (`loadNewer`) picks it up in its place. An *update* to a message
        // already in the window is a different thing and still lands: it
        // changes a message that is there rather than adding one that is not.
        //
        // An update to a message this room does not hold is dropped too, even
        // at the end: it is somewhere above the loaded history (never loaded,
        // or let go of, #173), and inserting it would float one old message
        // above everything else with a gap nobody can see.
        const holds = stream.messages.some((held) => held.id === message.id);
        const merged =
          holds || (frame.op === "message.create" && stream.atEnd)
            ? { ...stream, messages: mergeMessage(stream.messages, message) }
            : stream;
        // This announcement can beat the sender's own answer back
        // (`sendMessage` below); either way should clear the stand-in.
        if (frame.op !== "message.create") return merged;
        const at = merged.pending.findIndex((one) => matchesPending(one.message, message));
        if (at < 0) return merged;
        const pending = [...merged.pending];
        pending.splice(at, 1);
        return { ...merged, pending };
      });
      // Rooms nobody has opened have no stream to fold this into, and they are
      // exactly the rooms whose label has to change weight. So the newest id is
      // tracked separately from the history.
      const held = next.newest[message.room_id];
      if (frame.op === "message.create" && (held === undefined || held < message.id)) {
        next = { ...next, newest: { ...next.newest, [message.room_id]: message.id } };
      }
      // Saying the thing is how you stop typing it. Without this the line
      // hangs around for a few seconds after the message it was announcing has
      // already arrived, which reads as a second message that never comes.
      return frame.op === "message.create"
        ? stoppedTyping(next, message.room_id, message.author_id)
        : next;
    }
    case "message.delete": {
      const { id, room_id } = frame.d;
      // A delete is a tombstone, not a removal, so reply chains survive
      // (PROTOCOL §4). The frame carries no timestamp and nothing reads the
      // value — only whether there is one.
      return withStream(current, room_id, (stream) => ({
        ...stream,
        messages: stream.messages.map((held) =>
          held.id === id ? { ...held, body: "", deleted_at: held.deleted_at ?? Date.now() } : held,
        ),
      }));
    }
    case "knock": {
      // A knock is a moment, not a record (SPEC §4.9). It goes in so a card
      // can be drawn, the card takes itself off, and the list is empty again.
      //
      // Stale entries are dropped on the way in as well, because a card whose
      // timer was lost — a window backgrounded so long the timers were
      // throttled, a card unmounted by a re-render — must not come back later
      // as a knock from the past.
      const fresh = current.knocks.filter((held) => Date.now() - held.at < KNOCK_TTL_MS);
      // Named by the frame's sequence number, which is unique within a
      // connection (a fresh `ready` clears knocks anyway), so every window
      // that folds this frame names it the same: the Buddy list client's
      // windows must reach the same state from the same frames
      // (docs/design/architecture.md). The counter covers an unsequenced frame.
      knockSeq += 1;
      const id = frame.s === undefined ? `knock-local-${knockSeq}` : `knock-${frame.s}`;
      return {
        ...current,
        knocks: [...fresh, { id, from: frame.d.from_user_id, at: Date.now() }],
      };
    }
    case "typing": {
      const { room_id, user_id } = frame.d;
      return {
        ...current,
        typing: {
          ...current.typing,
          [room_id]: { ...current.typing[room_id], [user_id]: Date.now() },
        },
      };
    }
    // `reaction.update` is still sent, and deliberately not applied: the app
    // shows no reactions during the trial (#168), and a frame that changes
    // nothing on screen should not re-render anything.
    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Talking to the Tauri core
// ---------------------------------------------------------------------------

/**
 * The per-server bookkeeping that is not part of any snapshot: which sign-in we
 * are following, the token we last handed down, and the small timers the read
 * marker and the typing throttle keep. All of it dies with the connection.
 */
interface Link {
  api: AuthedApi;
  /**
   * The token we last handed down. Cleared once the handshake works, so a
   * second request for a token means the last one was refused rather than
   * expired — the case where only forcing a refresh gets us back on.
   */
  givenToken: string | null;
  supplying: Promise<void> | null;
  /** Room id → when we last wrote its read marker. */
  readSentAt: Record<string, number>;
  /** Room id → a pending read-marker write. */
  readTimers: Record<string, number>;
  /** Room id → when we last said we were typing in it. */
  typingSentAt: Record<string, number>;
}

/** The connections this store is following, keyed by base URL. */
const links = new Map<string, Link>();

/**
 * Where each server's snapshot stands: the session it was built from and the
 * last sequence number applied (`catchup.ts`). Updated in the same handler
 * that applies the frame, so a snapshot and its position can never disagree.
 * The Buddy list client's owner window hands both to a window that opens late.
 */
const positions = new Map<string, Position>();

// ---------------------------------------------------------------------------
// Following without connecting: the Buddy list client's viewer windows
// (docs/design/architecture.md, "How windows share state").
//
// The owner window connects, as today's client does. A viewer window never
// calls `connect`: the core already delivers every frame to every window, so
// a viewer only needs a link (for the REST helpers below, with a borrowed
// sign-in), the owner's snapshot to start from, and the same pure `apply`.
// None of the owner's side effects run here: no chimes, no notifications, no
// voice frames handed to the core, no token supplied to the gateway.
// ---------------------------------------------------------------------------

/**
 * Start following a server in a viewer window. History loads, sends, read
 * markers and typing go through `api`, which borrows the owner's sign-in.
 */
export function follow(api: AuthedApi): void {
  links.set(api.baseUrl, {
    api,
    givenToken: null,
    supplying: null,
    readSentAt: {},
    readTimers: {},
    typingSentAt: {},
  });
}

/** Stop following a server in a viewer window and forget what it said. */
export function unfollow(server: string): void {
  const link = links.get(server);
  links.delete(server);
  positions.delete(server);
  if (link) clearTimers(link);
  forget(server);
}

/**
 * Take the owner's snapshot as this window's copy. This window's own loaded
 * history is kept: the snapshot never carries any.
 */
export function adopt(server: string, snapshot: { state: GatewayState; position: Position }): void {
  positions.set(server, snapshot.position);
  publish(server, { ...snapshot.state, streams: stateOf(server).streams });
}

/** Apply one frame in a viewer window: the fold, and nothing else. */
export function applyFollowed(server: string, frame: ServerFrame): void {
  if (!links.has(server)) return;
  positions.set(server, advance(positions.get(server) ?? START, frame));
  publish(server, apply(stateOf(server), frame));
}

/** A viewer's copy of the connection's status, as the core reports it. */
export function followStatus(server: string, status: GatewayStatus): void {
  if (!links.has(server)) return;
  publish(server, { ...stateOf(server), status });
}

/** Where this window's copy of a server stands (`catchup.ts`). */
export function positionOf(server: string): Position {
  return positions.get(server) ?? START;
}

/**
 * The fields that change without a frame, which the owner keeps and shares
 * (docs/design/architecture.md, the table under "How windows share state").
 */
export type SharedLocal = Pick<GatewayState, "myVoice" | "read" | "readLoaded" | "notifyRules">;

export function sharedLocalOf(server: string): SharedLocal {
  const { myVoice, read, readLoaded, notifyRules } = stateOf(server);
  return { myVoice, read, readLoaded, notifyRules };
}

/** A viewer takes the owner's copy of those fields. */
export function adoptShared(server: string, shared: SharedLocal): void {
  if (!links.has(server)) return;
  publish(server, { ...stateOf(server), ...shared });
}

/** Be told whenever any server's state changes, outside React. */
export function onStateChange(notify: () => void): () => void {
  return subscribe(notify);
}

/**
 * One server's state as another window should adopt it, and the position it
 * is at. Loaded history is left out: every window loads what it shows.
 */
export function snapshotOf(server: string): { state: GatewayState; position: Position } {
  return {
    state: { ...stateOf(server), streams: {} },
    position: positions.get(server) ?? START,
  };
}

/**
 * The link for this exact sign-in, or null if it has been replaced.
 *
 * Every async path checks this before publishing. Comparing the `AuthedApi`
 * itself rather than the URL is what makes signing out and back into the same
 * server discard the first session's late answers.
 */
function linkFor(api: AuthedApi): Link | null {
  const link = links.get(api.baseUrl);
  return link !== undefined && link.api === api ? link : null;
}

async function supplyToken(server: string): Promise<void> {
  const link = links.get(server);
  if (!link) return;
  if (link.supplying) return link.supplying;
  const { api } = link;
  link.supplying = (async () => {
    try {
      const fresh = await api.accessToken(link.givenToken !== null);
      link.givenToken = fresh.token;
      await invoke("gateway_token", {
        baseUrl: server,
        token: fresh.token,
        expiresAtMs: fresh.expiresAt,
      });
    } catch {
      // A refused refresh already ends the session through `AuthedApi`; a
      // network failure is temporary and the core will ask again.
    } finally {
      link.supplying = null;
    }
  })();
  return link.supplying;
}

/**
 * Connects and disconnects for one server, one at a time.
 *
 * This queue is load-bearing, not tidiness. Both calls are async and both touch
 * the same module state, so two of them overlapping could leave a live socket
 * in the core with nothing in the WebView listening to it — the app looks
 * connected, says `ready`, and never applies another frame. React's StrictMode
 * double-invoke in development runs connect → disconnect → connect on every
 * mount, which is exactly that overlap, and it is the cause of the "one client
 * instance held a live socket that delivered no frames" sighting recorded
 * under T-410 and reproduced under T-412.
 */
const queues = new Map<string, Promise<void>>();

function inTurn(server: string, work: () => Promise<void>): Promise<void> {
  const held = queues.get(server) ?? Promise.resolve();
  // Both arms, so one failure does not wedge every later call for this server.
  const next = held.then(work, work);
  queues.set(server, next);
  return next;
}

/**
 * The two event listeners, attached once for every server rather than once per
 * connection. The core tags each event with the server it came from, so one
 * pair routes for all of them — and attaching a second pair would deliver every
 * frame twice.
 *
 * They are never taken down. There is one WebView and they cost nothing when
 * nobody is connected — every event for a server with no link is dropped by the
 * guard below. Detaching them was the other half of the bug above: a teardown
 * that landed after the next connect left the app deaf for the rest of its run.
 */
let listening: Promise<UnlistenFn[]> | null = null;

async function attachListeners(): Promise<void> {
  listening ??= Promise.all([
    listen<{ server: string; status: GatewayStatus }>("gateway:status", (event) => {
      const { server, status } = event.payload;
      const link = links.get(server);
      if (!link) return;
      // Nothing else knows the token was accepted, so this is where we learn
      // it, and where a later request means "refused", not "expired".
      if (status.kind === "ready") link.givenToken = null;
      if (status.kind === "needs_token") void supplyToken(server);
      publish(server, { ...stateOf(server), status });
    }),
    listen<{ server: string; frame: ServerFrame; replayed?: boolean }>("gateway:frame", (event) => {
      const { server, frame, replayed = false } = event.payload;
      if (!links.has(server)) return;
      const before = stateOf(server);
      const seated = before.myVoice !== null;
      const next = apply(before, frame);
      positions.set(server, advance(positions.get(server) ?? START, frame));
      publish(server, next);
      // After the fold, never before: whether a message is worth interrupting
      // somebody for depends on who they are and what rules they have, and
      // the snapshot is where both of those live.
      considerFrame(server, frame, next, replayed);
      // The card is drawn by the fold above; the noise is a side effect and
      // belongs out here with the other one. `playKnock` applies the mute and
      // the quiet hours itself, so a knock at 3am is a card and nothing more.
      if (!replayed) {
        if (frame.op === "knock") void playKnock();
        const cue = voiceCue(frame, before, next);
        if (cue !== null) void playSound(cue);
      }
      // Voice is the core's business, not this page's (ARCHITECTURE §2). These
      // two frames are handed straight over — the fold above ignores them, and
      // deliberately: nothing the store holds changes because a peer connection
      // did, and the voice surface (T-1404) will read the core's own events.
      if (frame.op === "voice.state" || frame.op === "voice.signal") {
        void voiceFrame(server, frame).then(() => {
          if (frame.op === "voice.state") applySavedVoiceVolumes(server);
        });
        // The fold above drops our seat if the server's list no longer has
        // us in it. The core still holds the devices, so tell it to let go —
        // a microphone left open after the server has said you are gone is
        // exactly the thing SPEC §4.14 is careful about.
        if (frame.op === "voice.state" && seated && next.myVoice === null) {
          void voiceLeave(server);
        }
      }
    }),
    // The core's own voice events (T-1402, T-1404): nothing on the wire,
    // everything about this machine's seat. Folded into `myVoice` and
    // ignored when we are not in voice, which is where a late event from a
    // call that just ended lands.
    listen<{ server: string; peer: string; state: string }>("voice:peer", (event) => {
      const { server, peer, state } = event.payload;
      const current = stateOf(server);
      if (current.myVoice === null) return;
      publish(server, {
        ...current,
        myVoice: { ...current.myVoice, peers: { ...current.myVoice.peers, [peer]: state } },
      });
    }),
    listen<{ server: string; state: string }>("voice:audio", (event) => {
      const { server, state } = event.payload;
      const current = stateOf(server);
      if (current.myVoice === null) return;
      publish(server, { ...current, myVoice: { ...current.myVoice, audio: state } });
    }),
    listen<{ server: string; peer: string | null; speaking: boolean }>(
      "voice:speaking",
      (event) => {
        const { server, peer, speaking } = event.payload;
        const current = stateOf(server);
        if (current.myVoice === null) return;
        const mine = current.myVoice;
        publish(server, {
          ...current,
          myVoice:
            peer === null
              ? { ...mine, talking: speaking }
              : { ...mine, speaking: { ...mine.speaking, [peer]: speaking } },
        });
      },
    ),
  ]);
  await listening;
}

/** Stop a link's pending writes. Its timers outlive it otherwise, and would
 *  fire against a sign-in that is gone. */
function clearTimers(link: Link): void {
  if (typeof window === "undefined") return;
  for (const timer of Object.values(link.readTimers)) window.clearTimeout(timer);
}

/**
 * Open a connection to one server and start following it. Replaces any previous
 * connection to the *same* server and leaves every other one alone.
 */
export function connect(api: AuthedApi): Promise<void> {
  return inTurn(api.baseUrl, () => open(api));
}

async function open(api: AuthedApi): Promise<void> {
  const server = api.baseUrl;
  await close(server);
  const link: Link = {
    api,
    givenToken: null,
    supplying: null,
    readSentAt: {},
    readTimers: {},
    typingSentAt: {},
  };
  links.set(server, link);
  publish(server, EMPTY);
  if (!isTauri()) return;

  await attachListeners();
  // No guard on the way out. Nothing can have disconnected this server while we
  // were on the network — the queue holds it until this returns — and a sign-out
  // that arrived meanwhile runs next and closes what we just opened.
  const token = await api.accessToken();
  link.givenToken = token.token;
  await invoke("gateway_connect", {
    baseUrl: server,
    token: token.token,
    expiresAtMs: token.expiresAt,
  });
}

/** Close one server's connection and forget everything it told us. */
export function disconnect(server: string): Promise<void> {
  return inTurn(server, () => close(server));
}

async function close(server: string): Promise<void> {
  const link = links.get(server);
  links.delete(server);
  positions.delete(server);
  if (link) clearTimers(link);
  forget(server);
  if (isTauri()) await invoke("gateway_disconnect", { baseUrl: server });
}

/**
 * Send one frame upstream. `false` means there was no live connection, which
 * callers treat as "say it again after the next `ready`" rather than an error.
 */
export async function send(server: string, frame: ClientFrame): Promise<boolean> {
  if (!isTauri()) return false;
  const sent: boolean = await invoke("gateway_send", { baseUrl: server, frame });
  return sent;
}

// ---------------------------------------------------------------------------
// Room history
// ---------------------------------------------------------------------------

/** Put one room's stream into the snapshot, creating it if it is new. */
function putStream(server: string, roomId: RoomId, stream: RoomStream): void {
  const current = stateOf(server);
  publish(server, { ...current, streams: { ...current.streams, [roomId]: stream } });
}

/**
 * Fetch the page before `from` and fold it in.
 *
 * A short answer is the start of the room: the range scan ran out before the
 * limit did.
 */
async function fetchPage(api: AuthedApi, roomId: RoomId, before: MessageId | null): Promise<void> {
  const server = api.baseUrl;
  const room = encodeURIComponent(roomId);
  const range = before === null ? "" : `&before=${encodeURIComponent(before)}`;
  let page: Message[];
  try {
    page = await api.get<Message[]>(`/rooms/${room}/messages?limit=${PAGE_SIZE}${range}`);
  } catch {
    // A page that didn't arrive doesn't need a state of its own. The status bar
    // is already saying what is wrong, and the next scroll asks again.
    const stream = stateOf(server).streams[roomId];
    if (linkFor(api) !== null && stream) putStream(server, roomId, { ...stream, loading: false });
    return;
  }
  const stream = stateOf(server).streams[roomId];
  if (linkFor(api) === null || !stream) return;
  // History let go of while this page was on the wire (#173) means it no
  // longer joins onto what is held. Folding it in would leave a gap, so it is
  // dropped and the next scroll asks again.
  if (before !== null && stream.messages[0]?.id !== before) {
    putStream(server, roomId, { ...stream, loading: false });
    return;
  }
  putStream(server, roomId, {
    ...stream,
    messages: mergePage(stream.messages, page),
    // A short page means the range scan ran out of room: this is the beginning.
    atStart: page.length < PAGE_SIZE,
    loading: false,
  });
}

/** How the halves of an `around` window are split, mirroring the server. */
const WINDOW_OLDER = Math.ceil(PAGE_SIZE / 2);
const WINDOW_NEWER = Math.floor(PAGE_SIZE / 2);

/**
 * Fetch the window centred on `around` (PROTOCOL §4) and fold it in.
 *
 * `replace` is the difference between landing on a search hit and reading
 * forwards out of one. Landing throws the loaded history away, because a
 * February window merged into an August one leaves a hole in the middle with
 * nothing to show that it is there. Reading forwards keeps it, because the two
 * overlap by construction: the window is centred on a message already held, so
 * its older half is history we have and its newer half is the next stretch,
 * with no room for a gap between them.
 *
 * Reading forwards this way costs half a page of messages already held. That is
 * the price of never producing a gap, and it is worth paying: `after` on this
 * endpoint answers newest-first, so it hands back the *newest* hundred messages
 * after a point rather than the next hundred — which is exactly the gap.
 */
async function fetchWindow(
  api: AuthedApi,
  roomId: RoomId,
  around: MessageId,
  replace: boolean,
): Promise<"failed" | "window" | "end"> {
  const server = api.baseUrl;
  const room = encodeURIComponent(roomId);
  let page: Message[];
  try {
    page = await api.get<Message[]>(
      `/rooms/${room}/messages?around=${encodeURIComponent(around)}&limit=${PAGE_SIZE}`,
    );
  } catch {
    const stream = stateOf(server).streams[roomId];
    if (linkFor(api) !== null && stream) putStream(server, roomId, { ...stream, loading: false });
    return "failed";
  }
  const current = stateOf(server);
  const stream = current.streams[roomId];
  if (linkFor(api) === null || !stream) return "failed";
  // Reading forwards overlaps what is held by construction — unless the
  // message it was centred on was let go of in the meantime (#173).
  if (!replace && !stream.messages.some((held) => held.id === around)) {
    putStream(server, roomId, { ...stream, loading: false });
    return "failed";
  }

  // Each half is capped on its own and neither borrows from the other, so a
  // short half is a real edge rather than an artefact of the limit.
  const older = page.filter((held) => held.id <= around).length;
  const newer = page.filter((held) => held.id > around).length;
  const messages = replace ? [...page].sort(byId) : mergePage(stream.messages, page);
  const pageEnds = newer < WINDOW_NEWER;
  // A message posted while this page was on the wire was dropped (the room
  // was not at its end yet) and is not in the page either. The newest id is
  // tracked from every frame, so it says whether that happened; if it did,
  // the room is not whole yet and `loadNewer` reads once more.
  const known = current.newest[roomId];
  const last = messages[messages.length - 1]?.id;
  const missedOne = known !== undefined && last !== undefined && known > last;
  putStream(server, roomId, {
    messages,
    atStart: replace ? older < WINDOW_OLDER : stream.atStart || older < WINDOW_OLDER,
    atEnd: pageEnds && !missedOne,
    loading: false,
    pending: stream.pending,
  });
  return pageEnds ? "end" : "window";
}

/**
 * Open a room: take a place in the store first, then fetch the newest page.
 *
 * That order is the point. From the moment the room is in `streams`, live
 * frames for it are kept, so a message posted while the first page is still on
 * the wire is not lost — the two get folded together whichever way they land.
 *
 * Opening a room that is already loaded does nothing, which is what keeps its
 * newest page when you switch away and come back (the rest is let go of on
 * the way out, `releaseOtherRooms`).
 */
export async function openRoom(api: AuthedApi, roomId: RoomId): Promise<void> {
  if (linkFor(api) === null || stateOf(api.baseUrl).streams[roomId]) return;
  putStream(api.baseUrl, roomId, { messages: [], atStart: false, atEnd: true, loading: true, pending: [] });
  await fetchPage(api, roomId, null);
}

/**
 * Open a room *at* one message rather than at its newest (SPEC §4.12).
 *
 * This is how a search hit is landed on, and paging backwards cannot do it: a
 * hit six months back in a busy room is thousands of messages behind the newest
 * one, which is dozens of round trips for history nobody asked to read.
 *
 * While the window is behind the newest message the room is *detached*:
 * `atEnd` is false, live frames for it are dropped rather than folded into a
 * history they do not join onto, and `loadNewer` reads forwards until the room
 * is whole again. `openRoom` after that does nothing, because the room is
 * already loaded — going back to the newest means dropping the room first,
 * which is what `leaveWindow` is for.
 */
export async function openAround(
  api: AuthedApi,
  roomId: RoomId,
  around: MessageId,
): Promise<void> {
  if (linkFor(api) === null) return;
  putStream(api.baseUrl, roomId, {
    messages: [],
    atStart: false,
    atEnd: false,
    loading: true,
    pending: [],
  });
  const landed = await fetchWindow(api, roomId, around, true);
  // The message is gone, or the server is. Either way the room is better off
  // showing its newest page than an empty window nobody can get out of.
  if (landed === "failed") await leaveWindow(api, roomId);
}

/**
 * Give up a historical window and open the room at its newest message again.
 *
 * Dropping the stream first is the whole of it: `openRoom` returns early for a
 * room that is already loaded, which is what keeps a room's newest page when
 * you switch rooms, and is exactly wrong here.
 */
export async function leaveWindow(api: AuthedApi, roomId: RoomId): Promise<void> {
  if (linkFor(api) === null) return;
  const current = stateOf(api.baseUrl);
  const streams = { ...current.streams };
  delete streams[roomId];
  publish(api.baseUrl, { ...current, streams });
  await openRoom(api, roomId);
}

/**
 * Letting go of history nobody is looking at (#173).
 *
 * Paging brings history in a hundred messages at a time, and the virtualizer
 * only draws what is on screen, but nothing used to leave: scroll back through
 * ten thousand messages and all ten thousand stayed in memory, in every room
 * you visited. So a room holds what is on screen plus `KEPT_BEYOND_VIEW`
 * either side, and only once it holds more than `TRIM_OVER` — a margin wide
 * enough that ordinary scrolling never notices, and a gap between the two so
 * it is not trimming on every page.
 *
 * Letting go of the newer end makes the room a historical window: `atEnd`
 * goes false, live messages wait on the server, and reading forwards brings
 * them back exactly as it does after a search hit (SPEC §4.12). Letting go of
 * the older end just means the next scroll up fetches it again.
 */
const KEPT_BEYOND_VIEW = 3 * PAGE_SIZE;
const TRIM_OVER = 8 * PAGE_SIZE;

/**
 * Trim the room on screen to what is shown plus a margin either side.
 *
 * `first` and `last` are the oldest and newest messages on screen. Does
 * nothing while a page is in flight, because the page would then land on
 * history that is no longer there to join onto.
 */
export function trimHistory(
  server: string,
  roomId: RoomId,
  first: MessageId,
  last: MessageId,
): void {
  const stream = stateOf(server).streams[roomId];
  if (!stream || stream.loading || stream.messages.length <= TRIM_OVER) return;
  const from = stream.messages.findIndex((held) => held.id === first);
  const to = stream.messages.findIndex((held) => held.id === last);
  if (from < 0 || to < from) return;
  const start = Math.max(0, from - KEPT_BEYOND_VIEW);
  const end = Math.min(stream.messages.length, to + 1 + KEPT_BEYOND_VIEW);
  if (start === 0 && end === stream.messages.length) return;
  putStream(server, roomId, {
    ...stream,
    messages: stream.messages.slice(start, end),
    atStart: start === 0 && stream.atStart,
    atEnd: end === stream.messages.length && stream.atEnd,
  });
}

/**
 * Let go of the history of every room except the one being opened.
 *
 * A room you walk back into lands on its newest message or on where you left
 * off, never on where you had scrolled to, so its scrollback is not what you
 * come back to. What is kept is its newest page, so it opens with something on
 * screen. A room showing a historical window is dropped whole: walking back in
 * leaves that window anyway.
 */
export function releaseOtherRooms(server: string, openRoomId: RoomId): void {
  const current = stateOf(server);
  let changed = false;
  const streams: Record<string, RoomStream> = {};
  for (const [roomId, stream] of Object.entries(current.streams)) {
    if (roomId === openRoomId || stream.loading || stream.pending.length > 0) {
      streams[roomId] = stream;
    } else if (!stream.atEnd) {
      changed = true;
    } else if (stream.messages.length > PAGE_SIZE) {
      changed = true;
      streams[roomId] = {
        ...stream,
        messages: stream.messages.slice(-PAGE_SIZE),
        atStart: false,
      };
    } else {
      streams[roomId] = stream;
    }
  }
  if (changed) publish(server, { ...current, streams });
}

/**
 * How far an explicit message jump walks before fetching a centered window. Ten pages is a
 * thousand messages; past that the line is somewhere you are not going to
 * scroll to anyway, and the alternative is a loop that pulls a year of history
 * because somebody was on holiday.
 */
const MAX_CATCHUP_PAGES = 10;

/**
 * Load older pages until `id` is inside the loaded range.
 *
 * Nearby reply and search targets reuse the loaded history. Distant targets
 * use `openAround`; room-entry bookmarks go directly through that path.
 *
 * Answers whether the room now actually holds that message. A caller that has
 * somewhere else to go when walking does not reach — a search hit thousands of
 * messages back — needs to know the difference between "it is here" and "I ran
 * out of pages", and "the oldest message held is older than it" is not the same
 * answer: a deleted or moved id passes that test and is still not there.
 */
export async function loadUntil(
  api: AuthedApi,
  roomId: RoomId,
  id: MessageId,
): Promise<boolean> {
  const holds = (): boolean =>
    stateOf(api.baseUrl).streams[roomId]?.messages.some((held) => held.id === id) ?? false;

  for (let page = 0; page < MAX_CATCHUP_PAGES; page += 1) {
    const stream = stateOf(api.baseUrl).streams[roomId];
    if (linkFor(api) === null || !stream || stream.atStart) return holds();
    const oldest = stream.messages[0];
    if (oldest !== undefined && oldest.id <= id) return holds();
    await loadOlder(api, roomId);
    // `loadOlder` declines while a page is already in flight. Nothing changed,
    // so asking again in a tight loop would only spin.
    if (stateOf(api.baseUrl).streams[roomId] === stream) return holds();
  }
  return holds();
}

/**
 * Fold a DM the server just handed back into the snapshot (SPEC §4.13).
 *
 * `POST /dms` answers with the room *and* the server publishes `room.create`
 * to its members, so this arrives twice by two routes. Merging by id makes
 * that harmless, and doing both means the DM is on screen the instant the
 * button was pressed rather than one round trip later — the same belt and
 * braces `sendMessage` uses, for the same reason.
 */
export function noteDm(server: string, dm: Room): void {
  const current = stateOf(server);
  publish(server, {
    ...current,
    dms: upsert(current.dms, dm, (held) => held.id === dm.id),
  });
}

/** Fetch the page before the oldest message held. Safe to call repeatedly. */
export async function loadOlder(api: AuthedApi, roomId: RoomId): Promise<void> {
  const stream = stateOf(api.baseUrl).streams[roomId];
  if (linkFor(api) === null || !stream || stream.loading || stream.atStart) return;
  const oldest = stream.messages[0];
  putStream(api.baseUrl, roomId, { ...stream, loading: true });
  await fetchPage(api, roomId, oldest?.id ?? null);
}

/**
 * Read forwards out of a historical window. Safe to call repeatedly.
 *
 * A room is behind its newest message when it was opened on a search hit, or
 * when the newer end of its history was let go of while reading far back
 * (#173). In the ordinary case this does nothing: `atEnd` is true from the
 * moment a room is opened the usual way.
 */
export async function loadNewer(api: AuthedApi, roomId: RoomId): Promise<void> {
  // Twice at most: the second read is only for a message that was posted
  // while the first was on the wire (see `fetchWindow`).
  for (let read = 0; read < 2; read += 1) {
    const stream = stateOf(api.baseUrl).streams[roomId];
    if (linkFor(api) === null || !stream || stream.loading || stream.atEnd) return;
    const newest = stream.messages[stream.messages.length - 1];
    if (newest === undefined) return;
    putStream(api.baseUrl, roomId, { ...stream, loading: true });
    if ((await fetchWindow(api, roomId, newest.id, false)) !== "end") return;
  }
}

/**
 * Post a message.
 *
 * The gateway sends the same message back as a frame, and merging is by id, so
 * folding the POST's own answer in here can't double it up. Doing both means
 * the message appears even when the socket is down and REST is fine.
 *
 * Failures are thrown, not swallowed: the composer is the only thing that knows
 * what the person was typing, so it is the only thing that can tell them.
 *
 * The message appears the instant this is called, not once the server answers
 * (issue #128) — see the stand-in built below and `PendingSend` on
 * `RoomStream`. Sending never waits on the round trip, and several of these
 * can be in flight at once; the composer no longer has to refuse a second
 * Enter while one is still open.
 */
export async function sendMessage(
  api: AuthedApi,
  roomId: RoomId,
  body: string,
  replyTo: MessageId | null = null,
  attachments: Attachment[] = [],
): Promise<void> {
  const server = api.baseUrl;
  const request: CreateMessageRequest = {
    body,
    reply_to: replyTo,
    // The files went up first and are already stored, checked and re-encoded;
    // this is the moment they become part of the conversation (PROTOCOL §6).
    attachment_ids: attachments.length === 0 ? null : attachments.map((one) => one.id),
  };

  const key = ++pendingSeq;
  const opening = stateOf(server).streams[roomId];
  const me = stateOf(server).me;
  // Only in the ordinary case — a room open at its newest message. A detached
  // search window (`openAround`) is not where a message you are sending now
  // belongs until the send actually lands there; `leaveWindow` below handles
  // getting back to "now" the way it already does.
  if (me !== null && opening && opening.atEnd && linkFor(api) !== null) {
    const standIn: Message = {
      id: `pending:${key}`,
      room_id: roomId,
      author_id: me.id,
      body,
      reply_to: replyTo,
      attachments,
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: Date.now(),
    };
    putStream(server, roomId, { ...opening, pending: [...opening.pending, { key, message: standIn }] });
  }

  const clearStandIn = (): void => {
    const stream = stateOf(server).streams[roomId];
    if (!stream) return;
    const pending = stream.pending.filter((one) => one.key !== key);
    if (pending.length !== stream.pending.length) putStream(server, roomId, { ...stream, pending });
  };

  const path = `/rooms/${encodeURIComponent(roomId)}/messages`;
  let message: Message;
  try {
    message = await api.post<Message>(path, request);
  } finally {
    // Whichever confirms the send first — this answer, or the room's own
    // announcement of it arriving first over the socket — clears the
    // stand-in; the other is then a no-op (see `matchesPending`).
    clearStandIn();
  }

  const stream = stateOf(server).streams[roomId];
  if (linkFor(api) === null || !stream) return;
  // Saying something out of a historical window puts you back at the newest
  // message. It cannot be folded into a February window — that is the gap this
  // store must never produce — and the alternative is a message you just sent
  // that does not appear anywhere.
  if (!stream.atEnd) {
    await leaveWindow(api, roomId);
    return;
  }
  putStream(server, roomId, { ...stream, messages: mergeMessage(stream.messages, message) });
}

/**
 * Change what a message says. Author only; the server enforces that and
 * refuses anyone else (PROTOCOL §4).
 *
 * Like sending, the answer is folded in directly as well as arriving as a
 * frame, so an edit lands even with the socket down. Failures are thrown for
 * the same reason: the edit box is holding the new text.
 */
export async function editMessage(
  api: AuthedApi,
  message: Message,
  body: string,
): Promise<void> {
  const request: EditMessageRequest = { body };
  const edited = await api.patch<Message>(`/messages/${encodeURIComponent(message.id)}`, request);
  const stream = stateOf(api.baseUrl).streams[edited.room_id];
  if (linkFor(api) === null || !stream) return;
  putStream(api.baseUrl, edited.room_id, {
    ...stream,
    messages: mergeMessage(stream.messages, edited),
  });
}

/**
 * Delete a message. Author or host (PROTOCOL §4).
 *
 * The row stays: a delete is a tombstone, so reply chains still point at
 * something. The server answers 204 and tells us nothing, so the local copy is
 * marked the same way the `message.delete` frame marks it.
 */
export async function deleteMessage(api: AuthedApi, message: Message): Promise<void> {
  await api.delete(`/messages/${encodeURIComponent(message.id)}`);
  if (linkFor(api) === null) return;
  publish(
    api.baseUrl,
    apply(stateOf(api.baseUrl), {
      op: "message.delete",
      d: { id: message.id, room_id: message.room_id },
    }),
  );
}

// ---------------------------------------------------------------------------
// Read markers, and where you left off
// ---------------------------------------------------------------------------

/**
 * You walked into a room: pin the "you left off here" line where you were.
 *
 * Call this once per entry and never per render. Inside a visit the line has to
 * hold still while you read past it, or it is not a mark you can find your way
 * back to. Walking out and back in is a different matter — that is a new visit,
 * and pinning it again is the only way the line means anything the second time.
 */
export function enterRoom(server: string, roomId: RoomId): void {
  const current = stateOf(server);
  const marker = current.read[roomId];
  if (marker === undefined || current.leftOff[roomId] === marker) return;
  publish(server, { ...current, leftOff: { ...current.leftOff, [roomId]: marker } });
}

/**
 * Fetch where you had got to in every room.
 *
 * `GET /read` answers with positions, not counts, and there is no endpoint that
 * would answer with a count (PROTOCOL §4). A failure is quiet: the worst case
 * is a session with no "you left off here" line, which is the app being less
 * helpful, not the app being wrong.
 */
export async function loadReadMarkers(api: AuthedApi): Promise<void> {
  let map: Record<string, MessageId> = {};
  try {
    map = await api.get<Record<string, MessageId>>("/read");
  } catch {
    // An unavailable bookmark must not prevent opening the conversation.
  }
  if (linkFor(api) === null) return;
  const current = stateOf(api.baseUrl);
  // Pin from the server's copy rather than the merged one. This answer and the
  // gateway's `ready` race on every cold start, so by the time it lands the open
  // room may already have been marked read — and the whole point of the line is
  // where you were *before* this session began.
  const leftOff = { ...current.leftOff };
  for (const [roomId, id] of Object.entries(map)) {
    leftOff[roomId] ??= id;
  }
  publish(api.baseUrl, { ...current, read: { ...map, ...current.read }, leftOff, readLoaded: true });
}

/** PROTOCOL §4: at most one read-marker write per five seconds per room. */
const READ_DEBOUNCE_MS = 5_000;

function flushRead(api: AuthedApi, roomId: RoomId): void {
  const link = linkFor(api);
  const last_read_id = stateOf(api.baseUrl).read[roomId];
  if (link === null || last_read_id === undefined) return;
  link.readSentAt[roomId] = Date.now();
  const body: UpdateReadMarkerRequest = { last_read_id };
  // Nothing shows a failure and nothing retries. The marker is a convenience,
  // the next `GET /read` is the truth, and a red line in the UI because a
  // bookmark did not save would be worse than the bookmark not saving.
  void api.put(`/rooms/${encodeURIComponent(roomId)}/read`, body).catch(() => undefined);
}

/**
 * Say you have read up to here.
 *
 * Moves only forward, and never moves the "you left off here" line — that one
 * was pinned when you walked in and stays where it is for the session.
 */
export function markRead(api: AuthedApi, roomId: RoomId, messageId: MessageId): void {
  const link = linkFor(api);
  if (link === null) return;
  const current = stateOf(api.baseUrl);
  const held = current.read[roomId];
  if (held !== undefined && held >= messageId) return;
  publish(api.baseUrl, { ...current, read: { ...current.read, [roomId]: messageId } });

  if (link.readTimers[roomId] !== undefined) return;
  const since = Date.now() - (link.readSentAt[roomId] ?? 0);
  if (since >= READ_DEBOUNCE_MS) {
    flushRead(api, roomId);
    return;
  }
  link.readTimers[roomId] = window.setTimeout(() => {
    delete link.readTimers[roomId];
    flushRead(api, roomId);
  }, READ_DEBOUNCE_MS - since);
}

/** True when a room holds something you have not seen (SPEC §4.2: weight, not a number). */
export function hasNewActivity(current: GatewayState, roomId: RoomId): boolean {
  const newest = current.newest[roomId];
  if (newest === undefined) return false;
  const read = current.read[roomId];
  return read === undefined || read < newest;
}

// ---------------------------------------------------------------------------
// Notify rules
// ---------------------------------------------------------------------------

function sameRule(a: NotifyRule, b: NotifyRule): boolean {
  return a.target_user_id === b.target_user_id && a.room_id === b.room_id;
}

/** "Always notify me when this person posts" — the whole list (SPEC §4.2). */
export async function loadNotifyRules(api: AuthedApi): Promise<void> {
  const rules = await api.get<NotifyRule[]>("/me/notify-rules");
  if (linkFor(api) === null) return;
  publish(api.baseUrl, { ...stateOf(api.baseUrl), notifyRules: rules });
}

/**
 * Turn one rule on or off. The local copy moves first so the switch answers
 * under the finger; a refusal puts it back and is thrown for the panel to show.
 */
export async function setNotifyRule(
  api: AuthedApi,
  rule: NotifyRule,
  on: boolean,
): Promise<void> {
  const server = api.baseUrl;
  const before = stateOf(server).notifyRules;
  const without = before.filter((held) => !sameRule(held, rule));
  publish(server, { ...stateOf(server), notifyRules: on ? [...without, rule] : without });
  try {
    if (on) await api.put("/me/notify-rules", rule);
    else await api.delete("/me/notify-rules", rule);
  } catch (error) {
    if (linkFor(api) !== null) publish(server, { ...stateOf(server), notifyRules: before });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

/**
 * How long a `typing.start` counts for. The server lets a client send one per
 * four seconds per room (`RATE_TYPING_PER_ROOM`), so this is that window plus
 * enough slack for a slow frame — long enough that someone typing steadily
 * never flickers, short enough that someone who walked away disappears.
 */
const TYPING_TTL_MS = 6_000;

/** Who is typing in a room right now, excluding you. Ids, oldest first. */
export function typistsIn(current: GatewayState, roomId: RoomId, now: number): UserId[] {
  const room = current.typing[roomId];
  if (!room) return [];
  return Object.entries(room)
    .filter(([userId, at]) => now - at < TYPING_TTL_MS && userId !== current.me?.id)
    .sort(([, a], [, b]) => a - b)
    .map(([userId]) => userId);
}

/**
 * Take one knock's card off the screen (T-1102).
 *
 * Called by the card itself when its time is up — there is no dismiss control,
 * because a knock you have to dismiss is a knock that wanted something from
 * you (SPEC §4.9). The store is the only place a knock exists, so this is also
 * the end of it: nothing is written down and nothing is left to find.
 */
export function dismissKnock(server: string, id: string): void {
  const current = stateOf(server);
  if (!current.knocks.some((knock) => knock.id === id)) return;
  publish(server, { ...current, knocks: current.knocks.filter((knock) => knock.id !== id) });
}

// --- voice (SPEC §4.14, T-1404) ---------------------------------------------

/** Who is in voice in a room, per the server's last word. Empty for nobody. */
export function voicePeersIn(current: GatewayState, roomId: RoomId): VoicePeer[] {
  return current.voice[roomId] ?? [];
}

/**
 * Turn the microphone on in a room (SPEC §4.14: joining voice is turning your
 * microphone on where you already are).
 *
 * You are in voice in at most one room, on one server, at a time — so any
 * seat held anywhere else is given up first, and the server sees a leave
 * before it sees the join. `startMuted` is for push-to-talk, which begins
 * quiet and opens on the key: the mute is set before the devices open so
 * not one frame of the room goes out before the key was held.
 *
 * Rejects with a sentence when the core cannot open the devices; nothing
 * was joined in that case and the store says so.
 */
export async function joinVoice(
  api: AuthedApi,
  roomId: RoomId,
  devices: VoiceDeviceChoice,
  startMuted: boolean,
): Promise<void> {
  const server = api.baseUrl;
  // A queued deafen must take effect before its choice is carried to another room.
  await Promise.all([...controlQueues.values()].map((pending) => pending.catch(() => undefined)));
  const current = stateOf(server);
  if (current.sessionId === null) throw new Error("Not connected yet.");
  const previous = Object.values(states).find((state) => state.myVoice !== null)?.myVoice;
  if (current.myVoice?.roomId === roomId) return;
  for (const [other, state] of Object.entries(states)) {
    if (state.myVoice !== null && (other !== server || state.myVoice.roomId !== roomId)) {
      await leaveVoice(other, false);
    }
  }
  publish(server, {
    ...stateOf(server),
    myVoice: {
      roomId,
      muted: previous?.deafened || startMuted || previous?.muted || false,
      deafened: previous?.deafened ?? false,
      mutedBeforeDeafen: startMuted || (previous?.mutedBeforeDeafen ?? false),
      pushToTalk: startMuted,
      moved: previous !== undefined && previous !== null,
      audio: "opening",
      peers: {},
      speaking: {},
      talking: false,
      volumes: {},
    },
  });
  try {
    const mine = stateOf(server).myVoice;
    if (mine === null) return;
    await voiceControls(server, { muted: mine.muted, deafened: mine.deafened });
    // The host's relay, if there is one (T-1403): STUN and TURN with a
    // password made for us just now. Asked on every join because the password
    // expires, and asked *before* the peer connections exist because ICE has
    // to know its servers when it starts. A server that cannot answer is a
    // join on one network only, not a refusal — that is a real deployment.
    const ice = await api
      .get<IceServers>("/voice/ice")
      .then((answer) => answer.servers)
      .catch(() => []);
    await voiceJoin(server, current.sessionId, roomId, devices, ice);
    applySavedVoiceVolumes(server);
  } catch (error) {
    publish(server, { ...stateOf(server), myVoice: null });
    throw error;
  }
}

/** Turn the microphone off and let every peer go. Safe to call when not in voice. */
export async function leaveVoice(server: string, chime = true): Promise<void> {
  const current = stateOf(server);
  if (current.myVoice !== null) publish(server, { ...current, myVoice: null });
  await controlQueues.get(server)?.catch(() => undefined);
  await voiceLeave(server);
  if (chime && current.myVoice !== null) void playSound("voice-leave");
}

const controlQueues = new Map<string, Promise<void>>();

/** Serialize rapid clicks and push-to-talk edges; never announce an unapplied mute. */
function changeVoiceControls(server: string, change: (mine: MyVoice) => MyVoice): Promise<void> {
  const task = (controlQueues.get(server) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const mine = stateOf(server).myVoice;
    if (mine === null) return;
    const next = change(mine);
    if (next === mine) return;
    try {
      await voiceControls(server, { muted: next.muted, deafened: next.deafened });
    } catch {
      publish(server, { ...stateOf(server), myVoice: null });
      try { await voiceLeave(server); } catch {
        throw new Error("Couldn't change voice controls or confirm voice stopped. Close the app to stop audio.");
      }
      throw new Error("Couldn't change voice controls. Voice was disconnected; join again to retry.");
    }
    const current = stateOf(server);
    if (current.myVoice === null) return;
    publish(server, { ...current, myVoice: {
      ...current.myVoice, muted: next.muted, deafened: next.deafened,
      mutedBeforeDeafen: next.mutedBeforeDeafen,
    } });
    if (mine.deafened !== next.deafened) void playSound(next.deafened ? "deafen" : "undeafen");
    else if (!mine.pushToTalk && mine.muted !== next.muted) void playSound(next.muted ? "mute" : "unmute");
  });
  controlQueues.set(server, task);
  void task.finally(() => {
    if (controlQueues.get(server) === task) controlQueues.delete(server);
  }).catch(() => undefined);
  return task;
}

/** Mute belongs to this session. While deafened, neither clicks nor PTT can reopen it. */
export function setVoiceMuted(server: string, muted: boolean): Promise<void> {
  return changeVoiceControls(server, (mine) => mine.deafened || mine.muted === muted
    ? mine : { ...mine, muted });
}

/** Silence both directions, preserving the prior mic choice and every peer's volume. */
export function setVoiceDeafened(server: string, deafened: boolean): Promise<void> {
  return changeVoiceControls(server, (mine) => mine.deafened === deafened ? mine : {
    ...mine, deafened,
    mutedBeforeDeafen: deafened ? mine.muted : mine.mutedBeforeDeafen,
    muted: deafened || mine.pushToTalk || mine.mutedBeforeDeafen,
  });
}

/** Apply saved levels after devices open and whenever a person's sessions change. */
function applySavedVoiceVolumes(server: string): void {
  const current = stateOf(server);
  const mine = current.myVoice;
  if (mine === null) return;
  const saved = loadVoiceVolumes(server);
  const volumes = { ...mine.volumes };
  for (const peer of current.voice[mine.roomId] ?? []) {
    if (peer.session_id === current.sessionId) continue;
    const volume = saved[peer.user_id] ?? volumes[peer.session_id] ?? 1;
    volumes[peer.session_id] = volume;
    void voiceVolume(server, peer.session_id, volume);
  }
  publish(server, { ...current, myVoice: { ...mine, volumes } });
}

/** How loud this person plays for you, across their sessions and future visits. */
export function setVoiceVolume(server: string, peer: string, volume: number): void {
  const current = stateOf(server);
  const mine = current.myVoice;
  if (mine === null) return;
  const peers = current.voice[mine.roomId] ?? [];
  const person = peers.find((seat) => seat.session_id === peer);
  if (!person || peer === current.sessionId) return;
  const level = clampVolume(volume);
  saveVoiceVolume(server, person.user_id, level);
  const volumes = { ...mine.volumes };
  for (const seat of peers) {
    if (seat.user_id !== person.user_id || seat.session_id === current.sessionId) continue;
    volumes[seat.session_id] = level;
    void voiceVolume(server, seat.session_id, level);
  }
  publish(server, { ...current, myVoice: { ...mine, volumes } });
}

/**
 * Tell the room you are writing something. Throttled here as well as on the
 * server, because being rate-limited is a refusal and there is no reason to
 * collect one on every keystroke. The server's window is four seconds
 * (`RATE_TYPING_PER_ROOM`), so this stays just inside it.
 */
export function startedTyping(api: AuthedApi, roomId: RoomId): void {
  const link = linkFor(api);
  if (link === null) return;
  const now = Date.now();
  if (now - (link.typingSentAt[roomId] ?? 0) < TYPING_TTL_MS - 2_000) return;
  link.typingSentAt[roomId] = now;
  void send(api.baseUrl, { op: "typing.start", d: { room_id: roomId } });
}

/**
 * Save your status (SPEC §4.6, PROTOCOL §5).
 *
 * `PATCH /me` replaces the whole status object when it is present, so the
 * caller has to send a complete one — half a status is a status with the other
 * half deleted. `status.ts::statusOf` is what builds it, and it carries over
 * the fields the editor does not own.
 *
 * `away_since` comes back server-stamped: it is set when an away message
 * appears or changes and cleared with it, and nothing the client sends for it
 * is read. That is why the answer is folded in rather than the local guess
 * kept — the roster's "away 20m" counts off the server's clock, not ours.
 *
 * Failures are thrown. The editor is holding the text and is the only thing
 * that can tell the person it did not save.
 */
function foldUser(api: AuthedApi, user: User): void {
  if (linkFor(api) === null) return;
  const current = stateOf(api.baseUrl);
  publish(api.baseUrl, {
    ...current,
    me: current.me?.id === user.id ? user : current.me,
    users: upsert(current.users, user, (u) => u.id === user.id),
  });
}

export async function saveStatus(api: AuthedApi, status: UserStatus): Promise<User> {
  const request: UpdateMeRequest = {
    display_name: null,
    style: null,
    status,
    entrance_sound: null,
  };
  const user = await api.updateMe(request);
  // The server also fans this out as `user.update`, which usually beats the
  // HTTP answer back. Folding it in anyway means the editor is never left
  // showing the old text because one frame went missing.
  foldUser(api, user);
  return user;
}

/**
 * Save a display name (T-411). Same fold as `saveStatus`: the HTTP answer is
 * the name you just typed, and waiting for the fan-out would leave the roster
 * and the status bar a round trip behind your own save.
 */
export async function saveDisplayName(api: AuthedApi, request: UpdateMeRequest): Promise<User> {
  const user = await api.updateMe(request);
  foldUser(api, user);
  return user;
}

/**
 * Save how your name is drawn (T-602). Same fold again, and it matters more
 * here than anywhere: the picker's preview and every name in the stream read
 * the same store, so folding the answer in is what makes your own name change
 * under you the moment it is saved.
 */
export async function saveStyle(api: AuthedApi, request: UpdateMeRequest): Promise<User> {
  const user = await api.updateMe(request);
  foldUser(api, user);
  return user;
}

/** The status bar line (SPEC §5.6): protocol text, never a spinner. */
export function statusText(status: GatewayStatus): string {
  switch (status.kind) {
    case "offline":
      return "offline";
    case "connecting":
      return "connecting…";
    case "connected":
      // Only claim TLS when there was a TLS handshake. A server on your own
      // machine over plain http gets the honest word instead.
      return status.tls ? "tls ok…" : "socket ok…";
    case "identifying":
      return "identify…";
    case "resuming":
      return "resume…";
    case "ready":
      return `ready (${status.latency_ms}ms)`;
    case "waiting":
      return `retry in ${Math.max(1, Math.round(status.retry_in_ms / 1000))}s…`;
    case "needs_token":
      return "renewing…";
  }
}
