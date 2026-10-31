/**
 * The Tauri side of updates (T-701, #772): Linger updates itself.
 *
 * These types mirror `src-tauri/src/updates.rs` by hand, the same way
 * `ipc.ts` mirrors `secrets.rs`: AGENTS rule 7 covers types crossing the
 * *wire*, and none of these ever leave the machine. A Rust test pins the
 * spellings so the two halves can't drift silently.
 *
 * The page never talks to the updater plugin. It calls the app's own
 * commands, and the capability files grant the plugin nothing — a WebView that
 * could download and run an installer is not a WebView with a minimum
 * permission set (ARCHITECTURE §7).
 *
 * `pnpm dev` in a plain browser has no shell to ask, so everything here reports
 * `unconfigured`, which is also what a build with no signing key reports. Both
 * mean the same thing to a reader: this copy cannot update itself.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PublicApi } from "./api";

/** A newer release, for a copy a package manager owns. */
export interface NewerRelease {
  version: string;
  /** One short line about what's in it, when the release has one. */
  line: string | null;
}

export type UpdateCheck =
  /**
   * A newer release this copy installs: by itself (`silent`: the setup.exe
   * and the AppImage), or only when asked, since installing needs a password
   * (the .deb, .rpm and .msi). `published` is when it came out (ms), and
   * `downloaded` whether it's on this computer, ready to install.
   */
  | { kind: "newer"; version: string; line: string | null; published: number | null; downloaded: boolean; silent: boolean }
  | { kind: "current"; silent: boolean }
  | { kind: "unconfigured" }
  | { kind: "failed"; reason: string }
  /** A package manager installed this copy and updates it (#188). */
  | { kind: "managed"; by: string; newer: NewerRelease | null };

/**
 * Only ever a reason it did not happen. A successful install replaces the
 * running process, so there is nothing left to resolve the promise.
 */
export type UpdateInstall =
  | { kind: "nothing" }
  /** Somebody's in voice or sharing a screen, by the shell's last check: nothing restarts now. */
  | { kind: "busy" }
  | { kind: "unconfigured" }
  | { kind: "failed"; reason: string }
  | { kind: "managed"; by: string };

/**
 * How Linger comes back after restarting to update: as usual, without taking
 * the focus (a restart nobody pressed), or in the tray, where the list was.
 */
export type ComeBack = "shown" | "behind" | "tray";

/** How long a release is out before a copy installs it by itself (`WAIT_MS` in updates.rs). */
export const WAIT_MS = 24 * 60 * 60 * 1000;

/** The version this copy was built as, or `null` outside the shell. */
export async function appVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const version: string = await invoke("app_version");
  return version;
}

/**
 * Look for a newer release. A copy that installs updates starts downloading
 * one that's a day old; `onUpdateDownloaded` hears when it's in.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) return { kind: "unconfigured" };
  const result: UpdateCheck = await invoke("update_check");
  return result;
}

/**
 * Install the newest release now and restart into it. Only the list window
 * asks, and only when nobody's in voice or sharing a screen; the shell checks
 * again right before installing. `automatic` is a restart nobody pressed:
 * then only the update already kept goes in, once its day is up. On success
 * this never returns.
 */
export async function updateNow(comeBack: ComeBack = "shown", automatic = false): Promise<UpdateInstall> {
  if (!isTauri()) return { kind: "unconfigured" };
  const result: UpdateInstall = await invoke("update_now", { comeBack, automatic });
  return result;
}

/** The version downloaded and waiting for this start, if there is one. */
export async function pendingUpdate(): Promise<string | null> {
  if (!isTauri()) return null;
  const version: string | null = await invoke("update_pending");
  return version;
}

/** Install the update waiting for this start, before the list is shown. On success this never returns. */
export async function installPendingUpdate(): Promise<UpdateInstall> {
  if (!isTauri()) return { kind: "nothing" };
  const result: UpdateInstall = await invoke("update_install_pending");
  return result;
}

/** Hear when a background download is in: ask again, and it's ready. Returns the way to stop. */
export function onUpdateDownloaded(listener: () => void): () => void {
  if (!isTauri()) return () => undefined;
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen("next:update", () => listener())
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

/**
 * Settings' opening words for Updates: how this copy updates. Pure, so each
 * kind of copy has words a test can read.
 */
export function updateLead(check: UpdateCheck | null): string {
  if (check?.kind === "managed") return "Your system installed this copy of Linger, and updates it along with everything else.";
  const silent = check?.kind === "newer" || check?.kind === "current" ? check.silent : true;
  if (!silent) {
    return "Linger looks for a new version when it starts and twice a day, and downloads it. Installing it asks for your computer's password, so it waits for you to press Update. Every update is checked against this project's signing key first, and Linger never restarts while you're in voice.";
  }
  return "Linger keeps itself up to date. It looks for a new version when it starts and twice a day, downloads it, and installs it the next time it starts. Every update is checked against this project's signing key first, and Linger never restarts while you're in voice.";
}

/**
 * The sentence Settings shows about a new version. Pure, so the wording is
 * testable without a shell: every state a reader can land in has a line, and
 * none of them is a raw error code. `now` decides whether a release is still
 * in its day's wait.
 */
export function updateLine(check: UpdateCheck | null, busy: boolean, now = Date.now()): string {
  if (busy) return "Looking…";
  if (check === null) return "";
  switch (check.kind) {
    case "newer": {
      const out = `Linger ${check.version} is out.`;
      if (!check.silent) return `${out} Updating asks for your computer's password, so it waits for you to press Update.`;
      if (check.downloaded) return `Linger ${check.version} is ready. It installs the next time Linger starts, or while you're away from your computer.`;
      if (check.published !== null && now - check.published < WAIT_MS) {
        return `${out} It installs by itself a day after it came out, or now with Restart now.`;
      }
      return `${out} It's downloading, and installs the next time Linger starts.`;
    }
    case "current":
      return "This is the newest version.";
    case "unconfigured":
      return "This copy was not built to update itself. Install a new one from the release page.";
    case "failed":
      return `Couldn't check for updates: ${check.reason}`;
    case "managed":
      if (check.newer === null) return "This is the newest version.";
      return `Linger ${check.newer.version} is out. ${systemUpdate(check.by)}`;
  }
}

/**
 * How a copy the system owns gets a new version, in words true on any system
 * that installs it that way: never a menu only one desktop has (#772).
 */
export function systemUpdate(by: string): string {
  return by === "pacman" ? "It comes with your next system update (sudo pacman -Syu)." : `It comes with your next system update, through ${by}.`;
}

/**
 * Where a version's release notes are published. Settings links there rather
 * than reprinting the notes (#174): they run to thousands of characters of
 * Markdown, which read as raw `#` and `-` in a settings panel and are
 * formatted and complete on the release page. When the notes move to a
 * website, this is the one line that changes.
 */
const RELEASE_NOTES_BASE = "https://github.com/itsMattGuenther/Linger/releases/tag/";

/** The release page for one version. Tags are `v`-prefixed; versions are not. */
export function releaseNotesUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${RELEASE_NOTES_BASE}${encodeURIComponent(tag)}`;
}

/**
 * The newest published release, whatever installed this copy (#314). A copy
 * the package manager owns still asks, since a host on Omarchy needs to know
 * their server is behind as much as anybody. `null` outside the shell, or when
 * the release feed couldn't be read.
 */
export async function newestVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const version: string | null = await invoke("newest_version");
  return version;
}

/** Where the host guide says how to update a server (#314). */
export const HOST_UPDATE_GUIDE_URL = "https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#updating-the-server";

/** Where the host guide says how to back a server up, and why its own copies aren't enough (#582). */
export const HOST_BACKUP_GUIDE_URL = "https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#backups";

/** `1.2.3` (or `v1.2.3`) as three numbers, or `null` for anything else. */
function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `version` is an older release than `than`. False when either isn't
 * a plain release number, so an odd answer never tells a host they're behind.
 */
export function isOlderVersion(version: string, than: string): boolean {
  const a = versionParts(version);
  const b = versionParts(than);
  if (a === null || b === null) return false;
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor < bMajor;
  if (aMinor !== bMinor) return aMinor < bMinor;
  return aPatch < bPatch;
}

/**
 * Whether this app is too old for a server (#793): the server's `oldest_client`
 * is a newer release than the app's own. Never when either is missing or
 * isn't a plain release number (`isOlderVersion`): a block has to be sure,
 * and an odd answer, or a build whose version can't be read, keeps working
 * as it did.
 */
export function needsNewerApp(app: string | null, oldestClient: string | null): boolean {
  return app !== null && oldestClient !== null && isOlderVersion(app, oldestClient);
}

/**
 * The newest of several servers' `oldest_client`, for one sentence about them
 * all (#793): an app at least that new works with every one. Unreadable ones
 * count for nothing.
 */
export function newestOf(versions: readonly string[]): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (versionParts(version) === null) continue;
    if (newest === null || isOlderVersion(newest, version)) newest = version;
  }
  return newest;
}

/** This copy's version, asked of the shell once per start: it can't change while Linger runs. */
let running: Promise<string | null> | null = null;

/** The version this copy was built as, asked once and kept; `null` outside the shell, or when it can't be read. */
export function thisVersion(): Promise<string | null> {
  running ??= appVersion().catch(() => null);
  return running;
}

/**
 * Whether the server at `baseUrl` needs a newer app than this one (#793):
 * the release it asks for when it does, otherwise null. It asks `/health`,
 * which needs no sign-in, so it still answers when the break is in signing
 * in. No answer, or one without the field, is null: a server that can't be
 * asked is somebody else's problem to report (the connection's), never a
 * block. Asks nothing when this copy's version can't be read.
 */
export async function newerAppFor(baseUrl: string, signal?: AbortSignal): Promise<string | null> {
  const app = await thisVersion();
  if (app === null) return null;
  const said = await new PublicApi(baseUrl).health(signal).catch(() => null);
  const oldest = said?.oldestClient ?? null;
  return needsNewerApp(app, oldest) ? oldest : null;
}

/** Whether two versions are the same release, both readable. */
function sameVersion(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  return x !== null && y !== null && x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/** What a host's app knows of their server's release: still asking, couldn't ask, or the answer. */
export type ServerVersion = { kind: "looking" } | { kind: "unknown" } | { kind: "known"; version: string };

/**
 * The sentence Settings → Hosting → Server shows about the server's release,
 * and whether there's a newer one to update to (#314). Pure, so every case has
 * words a test can read.
 */
export function serverVersionLine(server: ServerVersion, newest: string | null): { words: string; behind: boolean } {
  switch (server.kind) {
    case "looking":
      return { words: "Asking the server which version it runs…", behind: false };
    case "unknown":
      return { words: "Couldn't ask the server which version it runs.", behind: false };
    case "known": {
      const runs = `This server runs Linger ${server.version}`;
      if (newest === null) return { words: `${runs}.`, behind: false };
      if (isOlderVersion(server.version, newest)) return { words: `${runs}, and ${newest} is out.`, behind: true };
      return { words: sameVersion(server.version, newest) ? `${runs}, the newest.` : `${runs}.`, behind: false };
    }
  }
}
