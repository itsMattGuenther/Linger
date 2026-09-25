/**
 * Which conversation you are "in", when more than one window can show one
 * (docs/design/architecture.md, "Windows and their roles"). Presence puts you
 * in one room at a time (SPEC §4.3), so the owner keeps what every window
 * shows and picks the one in the window you were last in. Pure, so every case
 * is tested without windows.
 */
import type { RoomId } from "../../generated/RoomId";

export interface Shown {
  server: string | null;
  roomId: RoomId | null;
  /** When this window last gained focus; 0 if it never has. */
  focusedAt: number;
}

/** What each window shows, by window label. */
export type Showing = ReadonlyMap<string, Shown>;

export const NOTHING_SHOWN: Showing = new Map();

/** A window now shows this conversation, or none. */
export function show(showing: Showing, label: string, server: string, roomId: RoomId | null): Showing {
  const held = showing.get(label);
  return new Map(showing).set(label, { server, roomId, focusedAt: held?.focusedAt ?? 0 });
}

/** A window gained focus. */
export function focus(showing: Showing, label: string, at: number): Showing {
  const held = showing.get(label);
  return new Map(showing).set(label, { server: held?.server ?? null, roomId: held?.roomId ?? null, focusedAt: at });
}

/** A window closed: it shows nothing any more. */
export function close(showing: Showing, label: string): Showing {
  if (!showing.has(label)) return showing;
  const next = new Map(showing);
  next.delete(label);
  return next;
}

/**
 * The room you are in: the one shown in the window you were most recently
 * in, among those showing a room on a server you're signed in to, or null.
 * One room anywhere, across servers (lib/watchPresence, `setPresenceRoom`).
 */
export function presenceRoom(showing: Showing, servers: ReadonlySet<string>): { server: string; roomId: RoomId } | null {
  let best: { server: string; roomId: RoomId; focusedAt: number } | null = null;
  for (const { server, roomId, focusedAt } of showing.values()) {
    if (server === null || roomId === null || !servers.has(server)) continue;
    if (best === null || focusedAt > best.focusedAt) best = { server, roomId, focusedAt };
  }
  return best && { server: best.server, roomId: best.roomId };
}
