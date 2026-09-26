/**
 * Which servers search and media look through (docs/design/buddy-list.md,
 * "Several servers"). Pure; the picker in `app/ServerScope.tsx` draws it.
 *
 * With one server there is nothing to pick. With several, a view looks
 * through one of them or every one at once, and whatever it shows says which
 * server it came from, since two servers can both have a #general.
 */
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { UserId } from "../../generated/UserId";

/** The picker's value for every server at once. A server is picked by its address, which is never this. */
export const EVERY_SERVER = "every";

/** What the picker needs to know about a server. */
export interface ScopeServer {
  /** The server's address, which is also its key. */
  server: string;
  name: string;
  /** The host's color, a palette key; null until it's known. */
  accent: string | null;
}

/** A server as search and media see it: who's there and where, to name what they find. */
export interface ViewServer extends ScopeServer {
  /** Who you are there, for naming DMs by who else is in them. */
  me: UserId | null;
  users: readonly User[];
  /** Its rooms and the DMs you're in. */
  rooms: readonly Room[];
}

/**
 * Where a view starts: on the server it was opened from, when that's one of
 * them; on the only one there is; otherwise on every server.
 */
export function startScope(servers: readonly ScopeServer[], startOn?: string): string {
  const [only] = servers;
  if (servers.length === 1 && only) return only.server;
  if (startOn !== undefined && servers.some((one) => one.server === startOn)) return startOn;
  return EVERY_SERVER;
}

/** The picker's choices: every server first, then each in the list's order. */
export function scopeOptions(servers: readonly ScopeServer[]): { value: string; label: string }[] {
  return [{ value: EVERY_SERVER, label: "Every server" }, ...servers.map((one) => ({ value: one.server, label: one.name }))];
}

/**
 * The servers a scope covers, in the list's order. A server that has gone
 * (signed out while the view was open) covers every server instead of none.
 */
export function inScope<T extends ScopeServer>(scope: string, servers: readonly T[]): T[] {
  const one = servers.find((server) => server.server === scope);
  return one ? [one] : [...servers];
}
