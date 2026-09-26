/**
 * The arithmetic behind the host panel: invite links, how an invite is doing,
 * and what a reorder costs in PATCHes.
 *
 * None of this touches React or the network, which is the point — the panel
 * itself is judged by running the app, and these three are the parts where
 * being off by one would be invisible on screen.
 */
import type { Invite } from "../generated/Invite";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The link a host pastes into a text message (PROTOCOL §2.2).
 *
 * Nothing on the server serves this path. It is a shape the client parses
 * (`lib/link.ts`), so the two have to agree, and `host.test.ts` asserts that
 * they do by parsing what this builds.
 */
export function inviteUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite/${encodeURIComponent(code)}`;
}

/** Live, or the reason it is not. */
export type InviteState = "live" | "revoked" | "expired" | "spent";

export function inviteState(invite: Invite, now: number): InviteState {
  if (invite.revoked_at !== null) return "revoked";
  if (invite.expires_at !== null && invite.expires_at <= now) return "expired";
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return "spent";
  return "live";
}

/** "revoked" / "expired" / "all used up", or null while it still works. */
export function deadWords(invite: Invite, now: number): string | null {
  switch (inviteState(invite, now)) {
    case "revoked":
      return "revoked";
    case "expired":
      return "expired";
    case "spent":
      return "all used up";
    case "live":
      return null;
  }
}

/**
 * How long is left, in words rather than a timestamp. Rounded down, so
 * "expires in 2 days" never means "expired ten minutes ago".
 */
export function expiryWords(invite: Invite, now: number): string {
  if (invite.expires_at === null) return "never expires";
  const left = invite.expires_at - now;
  if (left <= 0) return "expired";
  if (left < HOUR_MS) return `expires in ${plural(Math.floor(left / MINUTE_MS), "minute")}`;
  if (left < DAY_MS) return `expires in ${plural(Math.floor(left / HOUR_MS), "hour")}`;
  return `expires in ${plural(Math.floor(left / DAY_MS), "day")}`;
}

/** How many people it will still let in, in words. */
export function useWords(invite: Invite): string {
  if (invite.max_uses === null) {
    return invite.uses === 0
      ? "for any number of people"
      : `for any number of people · ${invite.uses} so far`;
  }
  if (invite.max_uses === 1) return invite.uses === 0 ? "for one person" : "used";
  const left = Math.max(0, invite.max_uses - invite.uses);
  return `${left} of ${invite.max_uses} uses left`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Moving a room one place up or down the rail.
 *
 * The rail sorts on `position`, and nothing stops two rooms sharing one — so
 * this renumbers the whole list `0..n-1` in the new order and hands back only
 * the rooms whose number actually changed. On a tidy list that is the two rooms
 * that swapped; on a list that has drifted it quietly straightens it out. An
 * empty answer means the move was off the end and there is nothing to send.
 */
export function moveRoom(rooms: Room[], id: RoomId, delta: -1 | 1): Array<{
  id: RoomId;
  position: number;
}> {
  const order = [...rooms].sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug));
  const from = order.findIndex((room) => room.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [];

  const moved = order[from];
  const displaced = order[to];
  if (!moved || !displaced) return [];
  order[from] = displaced;
  order[to] = moved;

  const changes: Array<{ id: RoomId; position: number }> = [];
  order.forEach((room, index) => {
    if (room.position !== index) changes.push({ id: room.id, position: index });
  });
  return changes;
}
