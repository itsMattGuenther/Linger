/**
 * The Tauri side of in-app updates (T-701).
 *
 * These types mirror `src-tauri/src/updates.rs` by hand, the same way
 * `ipc.ts` mirrors `secrets.rs`: AGENTS rule 7 covers types crossing the
 * *wire*, and none of these ever leave the machine. A Rust test pins the
 * `kind` spellings so the two halves can't drift silently.
 *
 * The page never talks to the updater plugin. It calls two of the app's own
 * commands, and the capability file grants the plugin nothing — a WebView that
 * could download and run an installer is not a WebView with a minimum
 * permission set (ARCHITECTURE §7.7).
 *
 * `pnpm dev` in a plain browser has no shell to ask, so everything here reports
 * `unconfigured`, which is also what a build with no signing key reports. Both
 * mean the same thing to a reader: this copy cannot update itself.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export type UpdateCheck =
  | { kind: "ready"; version: string; notes: string | null }
  | { kind: "current" }
  | { kind: "unconfigured" }
  | { kind: "failed"; reason: string }
  // A package manager installed this copy and updates it (#188).
  | { kind: "managed"; by: string };

/**
 * Only ever a reason it did not happen. A successful install replaces the
 * running process, so there is nothing left to resolve the promise.
 */
export type UpdateInstall =
  | { kind: "unconfigured" }
  | { kind: "failed"; reason: string }
  | { kind: "managed"; by: string };

/** The version this copy was built as, or `null` outside the shell. */
export async function appVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const version: string = await invoke("app_version");
  return version;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) return { kind: "unconfigured" };
  const result: UpdateCheck = await invoke("update_check");
  return result;
}

/**
 * Download, verify, install, restart. On success this never returns — the app
 * is replaced by the new one — so anything it resolves with went wrong.
 */
export async function installUpdate(): Promise<UpdateInstall> {
  if (!isTauri()) return { kind: "unconfigured" };
  const result: UpdateInstall = await invoke("update_install");
  return result;
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
 * The sentence the settings panel shows. Pure, so the wording is testable
 * without a shell: every state a reader can land in has a line, and none of
 * them is a raw error code.
 */
export function updateLine(check: UpdateCheck | null, busy: boolean): string {
  if (busy) return "Looking…";
  if (check === null) return "";
  switch (check.kind) {
    case "ready":
      return `Version ${check.version} is ready to install.`;
    case "current":
      return "This is the newest version.";
    case "unconfigured":
      return "This copy was not built to update itself. Install a new one from the release page.";
    case "failed":
      return `Couldn't check for updates: ${check.reason}`;
    case "managed":
      // Omarchy's Update runs `pacman -Syu`, which is what brings it.
      return check.by === "pacman"
        ? "This copy updates with your system: use Update in the Omarchy menu, or run sudo pacman -Syu."
        : `This copy updates with your system, through ${check.by}.`;
  }
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
