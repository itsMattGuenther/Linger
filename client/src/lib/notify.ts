/**
 * The one thing in Linger allowed to interrupt you.
 *
 * SPEC §4.2 deletes the badge and replaces it with weight and a line in the
 * stream. The single exception is a message that names you, or one from
 * somebody you have explicitly asked to hear from — and that exception is
 * this file.
 *
 * Three rules shape it.
 *
 * **Nothing fires for something you are already looking at.** A notification
 * about a message on your screen, in the room you are reading, is noise.
 *
 * **Messages are batched per room.** A resume replays everything that happened
 * while the socket was down, which can be a burst; a burst must be one
 * notification, not thirty. The batch also means a conversation that mentions
 * you twice while you are making tea rings once.
 *
 * **No numbers, ever.** The notification names people and quotes the last
 * thing said. It never says how many messages are waiting, because that is the
 * badge wearing a different coat.
 *
 * Everything here is per server (T-412). Two servers can have a `#garage` each,
 * so a batch is keyed by both, and "the room you are looking at" is a server
 * and a room rather than a room on its own.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import type { MessageId } from "../generated/MessageId";
import type { RoomId } from "../generated/RoomId";
import type { ServerFrame } from "../generated/ServerFrame";
import type { GatewayState } from "./gateway";
import { isLooking } from "./looking";
import { playSound } from "./sound";
import { plainText } from "./markdown";
import { notificationText, notifyReason } from "./notify-rules";

/**
 * How long a room's messages are collected before one notification goes out.
 * Long enough to swallow a resume's replay, short enough that a message
 * arriving while you are away from the desk still feels prompt.
 */
const BATCH_MS = 1_200;

/** Which server's room is on screen. Set by the frame that is drawing it. */
let viewing: { server: string; roomId: RoomId } | null = null;

/** Tell the notifier which room you are looking at, if any. */
export function setViewing(at: { server: string; roomId: RoomId } | null): void {
  viewing = at;
}

/** Servers set to Quiet (the Buddy list client): no chimes from them. */
let quietServers: ReadonlySet<string> = new Set();

/**
 * Quiet a set of servers (docs/design/buddy-list.md, "Several servers"): their
 * messages make no sound. A mention still gets its banner, and knocks still get
 * through, because they are somebody asking for you rather than a room being
 * busy.
 */
export function setQuietServers(servers: ReadonlySet<string>): void {
  quietServers = servers;
}

interface Batch {
  server: string;
  roomId: RoomId;
  /** The latest message in it: where clicking the banner lands (decision 20). */
  messageId: MessageId;
  slug: string;
  /** Distinct, in the order they first spoke. */
  names: string[];
  /** The most recent thing said, as plain words. */
  excerpt: string;
}

/** Keyed by server and room, because a room id only means anything next to
 *  the server it came from. */
const batches = new Map<string, Batch>();
let flushIn: number | null = null;

function batchKey(server: string, roomId: RoomId): string {
  return `${server}\u0000${roomId}`;
}

/**
 * Look at one frame and decide whether it is worth saying something about.
 *
 * Takes the snapshot rather than reading the store, so the decision is made
 * against the state that includes this very frame and nothing later.
 */
export function considerFrame(
  server: string,
  frame: ServerFrame,
  snapshot: GatewayState,
  replayed = false,
): void {
  if (frame.op !== "message.create") return;
  const me = snapshot.me;
  if (me === null) return;

  const message = frame.d;
  if (message.author_id === me.id || message.deleted_at !== null) return;
  // You are looking right at it. `isLooking` is the same clock the
  // read-marker uses: the window has your attention, not merely a room
  // selected on a second monitor.
  if (viewing?.server === server && viewing.roomId === message.room_id && isLooking()) return;

  const dm = snapshot.dms.some((room) => room.id === message.room_id);
  // Sound switches are independent of desktop-banner rules and permission.
  if (!replayed && !quietServers.has(server)) void playSound(dm ? "dm" : "room");
  if (notifyReason(message, me, snapshot.notifyRules) === null) return;

  const slug = snapshot.rooms.find((room) => room.id === message.room_id)?.slug ?? "a room";
  const name =
    snapshot.users.find((person) => person.id === message.author_id)?.display_name ?? "someone";

  const key = batchKey(server, message.room_id);
  const held = batches.get(key);
  if (held === undefined) {
    batches.set(key, { server, roomId: message.room_id, messageId: message.id, slug, names: [name], excerpt: plainText(message.body) });
  } else {
    if (!held.names.includes(name)) held.names.push(name);
    held.excerpt = plainText(message.body);
    held.messageId = message.id;
  }
  if (flushIn === null) flushIn = window.setTimeout(flush, BATCH_MS);
}

function flush(): void {
  flushIn = null;
  const pending = [...batches.values()];
  batches.clear();
  for (const batch of pending) {
    const { title, body } = notificationText(batch.slug, batch.names, batch.excerpt);
    void show(title, body, { server: batch.server, room: batch.roomId, message: batch.messageId });
  }
}

/**
 * Asked for once and remembered. `null` means we have not asked yet.
 *
 * A refusal is final and silent: somebody who turned notifications off at the
 * OS level has already said what they want, and asking again every time
 * somebody says their name would be exactly the pestering this app exists to
 * not do.
 */
let allowed: boolean | null = null;

/**
 * Where a banner leads. The desktop shell hands it back to the list window
 * when the banner is clicked (`src-tauri/src/notifications.rs`), which opens
 * the conversation at the message (decision 20).
 */
export interface BannerTarget {
  server: string;
  room: RoomId;
  message: MessageId;
}

async function show(title: string, body: string, open: BannerTarget): Promise<void> {
  if (!isTauri()) return;
  try {
    if (allowed === null) {
      allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    }
    if (!allowed) return;
    await invoke("show_notification", { title, body, open });
  } catch {
    // No notification daemon, a sandbox with no portal, a headless session.
    // The stream still shows the message; there is nothing to tell anyone.
  }
}

/** Drop everything pending. Used when the app goes away. */
export function resetNotifications(): void {
  if (flushIn !== null) window.clearTimeout(flushIn);
  flushIn = null;
  batches.clear();
  viewing = null;
}

/**
 * Drop what one server was about to say. Signing out of a server should not
 * fire a notification about it a second later, and the other servers' pending
 * batches have nothing to do with it.
 */
export function forgetNotifications(server: string): void {
  for (const key of [...batches.keys()]) {
    if (key.startsWith(`${server}\u0000`)) batches.delete(key);
  }
  if (viewing?.server === server) viewing = null;
}
