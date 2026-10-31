/**
 * The standing lines at the foot of the list (decision 1): the jobs today's
 * status bar did, said only while they're true. A connection in trouble, a
 * computer that can't keep a sign-in, the host's server needing them (#582)
 * or behind (#772), and a new version: ready to install, out for a copy that
 * doesn't install it itself, or just installed (#772). When all is well there
 * are none, and the list has no bar at all.
 */
import type { ServerHealth } from "../../generated/ServerHealth";
import type { GatewayStatus } from "../../lib/gateway";
import { isOlderVersion, type UpdateCheck } from "../../lib/updates";

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
   * space nearly used up, no backup for days, or none reaching the host's
   * bucket for days (#614). The host's alone; the server tells nobody else.
   */
  | { kind: "host"; server: string; what: HostTrouble; words: string; detail: string }
  /**
   * A new version on this computer, ready, that installs by itself (#772):
   * calm, since there's nothing anybody has to do. `problem` is why the last
   * Restart now didn't happen.
   */
  | { kind: "update"; version: string; words: string; detail: string; problem: string | null }
  /**
   * A new version that somebody has to install (#772), in the lamp: a copy
   * that needs a password to install (`password`, with Update), or one the
   * system updates (with how).
   */
  | { kind: "release"; version: string; words: string; line: string | null; detail: string | null; password: boolean; problem: string | null }
  /** The version just installed, once, on its first start (#772), with what's in it. */
  | { kind: "updated"; version: string; words: string; line: string | null };

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

/** What a host line is about. `behind`: a newer release is out for the server (#772). */
export type HostTrouble = "disk" | "files" | "backup" | "bucket" | "behind";

/**
 * A server you host, and what it says about its machine (`GET /server`'s
 * `health`), and the release it runs (`/health`'s `version`), once it's said.
 */
export interface Hosted {
  server: string;
  name: string;
  health: ServerHealth;
  runs?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A hosted server's lines, only while each is true (#582). Words, never a
 * figure from the disk: "nearly full" is what the host needs to hear, and the
 * Settings it opens says the rest.
 */
export function hostNotes({ server, name, health, runs }: Hosted, now: number, newest: string | null = null): ListNote[] {
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
  // The bucket (#614) only once the copy itself is fine: with no copy there
  // is nothing to send, and the line above already says so.
  const bucket = health.bucket;
  if (health.backups && !health.backup_overdue && bucket?.overdue) {
    const last = bucket.last_sent_at;
    const days = last === null ? 0 : Math.floor((now - last) / DAY_MS);
    notes.push({
      kind: "host",
      server,
      what: "bucket",
      words:
        last === null || days < 1
          ? `${name}'s backups haven't reached its bucket yet.`
          : `${name}'s backups haven't reached its bucket for ${days} ${days === 1 ? "day" : "days"}.`,
      detail: `The server sends each night's copy to the bucket ${bucket.name} as well. Its log says why it couldn't.`,
    });
  }
  // Behind (#772): apps update themselves now, and a server only when its
  // host runs ./update.sh, so the host hears it here, not only in Settings
  // (#314). One version in the words: two side by side read as one blur.
  if (runs && newest && isOlderVersion(runs, newest)) {
    notes.push({
      kind: "host",
      server,
      what: "behind",
      words: `${name} is behind. ${newest} is out.`,
      detail: `It runs ${runs}. Run ./update.sh in the server's folder to update it.`,
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
 * reached yet, then the keyring, then the servers you host, then updates
 * (`updateNotes`). `device` is what the keyring's note calls this device
 * (`core/phone.ts`, `thisDevice`); `newest` is the newest release, for a host
 * whose server is behind.
 */
export function listNotes(
  connections: readonly Connection[],
  keyring: string | null,
  updates: readonly ListNote[],
  now: number,
  waiting: readonly Waiting[] = [],
  device = "this computer",
  hosted: readonly Hosted[] = [],
  newest: string | null = null,
): ListNote[] {
  const notes: ListNote[] = [];
  for (const connection of connections) {
    const note = connectionNote(connection, now);
    if (note) notes.push(note);
  }
  for (const one of waiting) notes.push(waitingNote(one));
  if (keyring !== null) notes.push({ kind: "keyring", words: `Sign-ins aren't remembered on ${device}.`, detail: keyring });
  for (const one of hosted) notes.push(...hostNotes(one, now, newest));
  notes.push(...updates);
  return notes;
}

/** What the list knows about updates when it draws its foot (#772). */
export interface UpdateState {
  check: UpdateCheck | null;
  /** The version just installed, on its first start, and what's in it. */
  updated: { version: string; line: string | null } | null;
  /** Whether a notice about this version was put off until tomorrow. */
  putOff: (version: string) => boolean;
  /** Why the last Update or Restart now didn't happen. */
  problem: string | null;
}

/**
 * The foot's update lines (#772). Just installed: "You're on Linger 0.5.4",
 * once. A copy that installs by itself: a calm line once the update is on
 * this computer, and nothing before (it's on its day's wait, or downloading).
 * A copy that needs a password: the lamp's "is out" once it's downloaded, with
 * Update. A copy the system updates: the lamp's "is out", with how to get it.
 * The two "is out" lines can be put off until tomorrow.
 */
export function updateNotes({ check, updated, putOff, problem }: UpdateState): ListNote[] {
  const notes: ListNote[] = [];
  if (updated) notes.push({ kind: "updated", version: updated.version, words: `You're on Linger ${updated.version}`, line: updated.line });
  if (check?.kind === "newer" && check.downloaded) {
    if (check.silent) {
      notes.push({
        kind: "update",
        version: check.version,
        words: `Linger ${check.version} is ready`,
        detail: "It installs the next time Linger starts, or while you're away from your computer.",
        problem,
      });
    } else if (!putOff(check.version)) {
      notes.push({ kind: "release", version: check.version, words: `Linger ${check.version} is out`, line: check.line, detail: null, password: true, problem });
    }
  }
  if (check?.kind === "managed" && check.newer && !putOff(check.newer.version)) {
    const { version, line } = check.newer;
    // Not "now": the system's repository fills a few minutes after a release
    // (arch-repo.yml), so nothing here promises it's there yet. Settings says
    // how, in words true on any such system (`systemUpdate`).
    notes.push({ kind: "release", version, words: `Linger ${version} is out`, line, detail: "It comes with your next system update.", password: false, problem: null });
  }
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
