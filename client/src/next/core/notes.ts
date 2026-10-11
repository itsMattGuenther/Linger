/**
 * The standing lines at the foot of the list (decision 1): the jobs today's
 * status bar did, said only while they're true. A connection in trouble, a
 * computer that can't keep a sign-in, the host's server needing them (#582),
 * and a new version waiting. When all is well there are none, and the list
 * has no bar at all.
 */
import type { ServerHealth } from "../../generated/ServerHealth";
import type { GatewayStatus } from "../../lib/gateway";
import type { UpdateCheck } from "../../lib/updates";

/**
 * How long a server may be connecting before the list says so. Every launch
 * and every short blip connects in less; a line that flashed on each would
 * be noise, and the old status bar's "connecting…" was exactly that.
 */
export const TROUBLE_GRACE_MS = 5_000;

/**
 * How often a list that stays open (in the tray, for days) looks for a new
 * version again. The first look is at launch.
 */
export const UPDATE_EVERY_MS = 12 * 60 * 60 * 1000;

export type ListNote =
  /** A server that isn't connected, past the grace. `detail` is the reason, when there is one. */
  | { kind: "connection"; server: string; words: string; detail: string | null }
  /**
   * A saved server that hasn't come back this launch (T-907): its sign-in is
   * kept and Linger keeps trying. `trying` while a try is under way; between
   * tries the line offers one now.
   */
  | { kind: "waiting"; server: string; words: string; detail: string | null; trying: boolean }
  /** The keyring refused: sign-ins last until Linger quits. */
  | { kind: "keyring"; words: string; detail: string }
  /**
   * The host's server needs them (#582): its disk nearly full, its file
   * space nearly used up, or no backup for days. The host's alone; the
   * server tells nobody else.
   */
  | { kind: "host"; server: string; what: HostTrouble; words: string; detail: string }
  /** A new version, ready to install from Settings. */
  | { kind: "update"; version: string; words: string };

export interface Connection {
  server: string;
  /** The server's name, or its address while it hasn't said. */
  name: string;
  status: GatewayStatus;
  /** When it last stopped being connected; null while it is. */
  troubleSince: number | null;
}

/** One server's line, or null while it's fine or still within the grace. */
export function connectionNote(connection: Connection, now: number): ListNote | null {
  const { server, name, status, troubleSince } = connection;
  if (status.kind === "ready" || troubleSince === null) return null;
  if (now - troubleSince < TROUBLE_GRACE_MS) return null;
  switch (status.kind) {
    case "waiting":
      return { kind: "connection", server, words: `Can't reach ${name}. Still trying.`, detail: status.reason };
    case "needs_token":
      return { kind: "connection", server, words: `Signing back in to ${name}…`, detail: null };
    default:
      return { kind: "connection", server, words: `Connecting to ${name}…`, detail: null };
  }
}

/** What a host line is about. */
export type HostTrouble = "disk" | "files" | "backup";

/** A server you host, and what it says about its machine (`GET /server`'s `health`). */
export interface Hosted {
  server: string;
  name: string;
  health: ServerHealth;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A hosted server's lines, only while each is true (#582). Words, never a
 * figure from the disk: "nearly full" is what the host needs to hear, and the
 * Settings it opens says the rest.
 */
export function hostNotes({ server, name, health }: Hosted, now: number): ListNote[] {
  const notes: ListNote[] = [];
  if (health.disk_nearly_full) {
    notes.push({
      kind: "host",
      server,
      what: "disk",
      words: `The disk ${name} runs on is nearly full.`,
      detail: "Less than a tenth of it is free. A full disk stops the server for everybody.",
    });
  }
  if (health.file_space_nearly_full) {
    notes.push({
      kind: "host",
      server,
      what: "files",
      words: `${name} is nearly out of room for files.`,
      detail: "Files take nearly all the room it allows them (LINGER_POOL_BYTES).",
    });
  }
  if (health.backups && health.backup_overdue) {
    const last = health.last_backup_at;
    const days = last === null ? 0 : Math.floor((now - last) / DAY_MS);
    notes.push({
      kind: "host",
      server,
      what: "backup",
      words: last === null || days < 1 ? `${name} hasn't been backed up yet.` : `${name} hasn't been backed up for ${days} ${days === 1 ? "day" : "days"}.`,
      detail: "The server copies its database into data/backups every night. Its log says why it couldn't.",
    });
  }
  return notes;
}

/** A saved server not reached yet, by its address: it hasn't said its name this launch. */
export interface Waiting {
  server: string;
  name: string;
  /** Why the last try failed; null while one is under way. */
  why: string | null;
}

/** A waiting server's line. */
export function waitingNote({ server, name, why }: Waiting): ListNote {
  return why === null
    ? { kind: "waiting", server, words: `Connecting to ${name}…`, detail: null, trying: true }
    : { kind: "waiting", server, words: `Can't reach ${name}. Still trying.`, detail: why, trying: false };
}

/**
 * Everything the foot says, most pressing first: connections and servers not
 * reached yet, then the keyring, then the servers you host, then an update.
 * `device` is what the keyring's note calls this device (`core/phone.ts`,
 * `thisDevice`).
 */
export function listNotes(
  connections: readonly Connection[],
  keyring: string | null,
  update: UpdateCheck | null,
  now: number,
  waiting: readonly Waiting[] = [],
  device = "this computer",
  hosted: readonly Hosted[] = [],
): ListNote[] {
  const notes: ListNote[] = [];
  for (const connection of connections) {
    const note = connectionNote(connection, now);
    if (note) notes.push(note);
  }
  for (const one of waiting) notes.push(waitingNote(one));
  if (keyring !== null) notes.push({ kind: "keyring", words: `Sign-ins aren't remembered on ${device}.`, detail: keyring });
  for (const one of hosted) notes.push(...hostNotes(one, now));
  if (update?.kind === "ready") notes.push({ kind: "update", version: update.version, words: `Linger ${update.version} is ready.` });
  return notes;
}

/**
 * When each server stopped being connected, carried from one look to the
 * next: kept while it stays in trouble, set when it falls into it, dropped
 * when it's back. A server seen for the first time counts from `now`.
 */
export function troubleSince(
  held: ReadonlyMap<string, number>,
  statuses: ReadonlyMap<string, GatewayStatus["kind"]>,
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [server, kind] of statuses) {
    if (kind === "ready") continue;
    next.set(server, held.get(server) ?? now);
  }
  return next;
}
