/**
 * What closing the list does (decisions 4 and 5, WIN-7): keep Linger running
 * in the tray, the default, so voice and notifications go on; or quit it and
 * every window with it. Kept on this computer. The list window hands it to the
 * desktop shell (`next_close_to_tray`, src-tauri/src/tray.rs), which does the
 * closing; a desktop with no tray quits whatever this says. The first time
 * the list goes to the tray, Linger says where it went (#400).
 */
import type { ModeStore } from "./conversations";

export type CloseList = "tray" | "quit";

const KEY = "linger.next.closeList";

export function loadCloseList(store: ModeStore | null): CloseList {
  try {
    return store?.getItem(KEY) === "quit" ? "quit" : "tray";
  } catch {
    return "tray";
  }
}

export function saveCloseList(store: ModeStore | null, value: CloseList): void {
  try {
    store?.setItem(KEY, value);
  } catch {
    // Storage refused: this run keeps the choice, the next starts on the tray.
  }
}

const TOLD = "linger.next.toldTray";

/**
 * Whether this is the first time ever the list has gone to the tray on this
 * computer (#400), remembering that it isn't any more. Storage that refuses
 * counts as told: a notice that came back on every close would be worse than
 * one that never came.
 */
export function firstTimeInTray(store: ModeStore | null): boolean {
  try {
    if (!store || store.getItem(TOLD) === "yes") return false;
    store.setItem(TOLD, "yes");
    return true;
  } catch {
    return false;
  }
}

/** Which desktop this is, for the notice's words only, read from the engine's user agent. */
export type Desktop = "windows" | "mac" | "other";

export function desktopOf(userAgent: string): Desktop {
  if (/\bWindows\b/.test(userAgent)) return "windows";
  if (/\bMacintosh\b/.test(userAgent)) return "mac";
  return "other";
}

/** Where the tray icon is, on each desktop. */
const TRAY_AT: Record<Desktop, string> = {
  windows: "It's by the clock (under ^).",
  mac: "It's in the menu bar, at the top of the screen.",
  other: "It's in your system tray.",
};

/** Where you're in voice: a room's `#name`, or the people in a DM. */
export interface VoicePlace {
  where: string;
  room: boolean;
}

/**
 * What Linger says the first time the list goes to the tray (#400). Windows 11
 * puts a new app's tray icon under the ^ by the clock, and only the person can
 * bring it out, so the notice says where Linger went and how to quit it for
 * good. In voice it says so too: the microphone is still live with nothing of
 * Linger on screen.
 */
export function trayNotice(desktop: Desktop, voice: VoicePlace | null): { title: string; body: string } {
  const lines = [TRAY_AT[desktop], "Quit Linger from there."];
  if (voice) lines.push(`You're still in voice ${voice.room ? "in" : "with"} ${voice.where}.`);
  return { title: "Linger is still running", body: lines.join(" ") };
}
