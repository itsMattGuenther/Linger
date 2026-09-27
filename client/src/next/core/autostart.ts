/**
 * Starting Linger when you sign in to the computer (#228). Off unless you
 * turn it on in Settings → Account & App.
 *
 * There is nothing kept here: the desktop shell asks the operating system
 * every time (`src-tauri/src/autostart.rs`), so the switch shows what the next
 * sign-in will do, even after a change made outside Linger. Settings calls
 * these itself; it's a setting of this computer, with nothing for the list
 * window to keep in step.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The shell's answer. Hand-written on both sides, mirrored from `Startup` in
 * `src-tauri/src/autostart.rs`, whose test pins these names; it never crosses
 * the wire.
 */
export interface Startup {
  /** Whether the next sign-in starts Linger. */
  on: boolean;
  /**
   * The desktop running now, by its own name ("" when it gives none), when
   * it doesn't start what's in the autostart folder by itself (Hyprland as
   * Omarchy starts it, Sway, i3). Null everywhere else.
   */
  ignored_by: string | null;
}

/** How it stands, for Settings to draw. */
export interface StartAtSignIn {
  /** What the computer says. */
  on: boolean;
  /** A desktop that won't start it by itself, by name ("" when unnamed), or null. */
  ignoredBy: string | null;
  /** A change is on its way to the computer. */
  changing: boolean;
  /** Why the last change or look didn't happen, in words. */
  problem: string | null;
}

/** Where the user guide says what to add on a desktop that ignores the switch. */
export const START_GUIDE_URL = "https://github.com/itsMattGuenther/Linger/blob/main/docs/user-guide.md#starting-linger-when-you-sign-in";

/** What the computer says now, or null where it isn't offered (a browser; macOS for now). */
export async function startsAtSignIn(): Promise<Startup | null> {
  if (!isTauri()) return null;
  const now: Startup | null = await invoke("autostart_state");
  return now;
}

/** Turn it on or off. Resolves to what the computer says afterwards; rejects with the reason. */
export async function setStartsAtSignIn(on: boolean): Promise<Startup> {
  const now: Startup = await invoke("autostart_set", { on });
  return now;
}

/**
 * The line Settings shows when a change didn't happen. The shell's reason is
 * already a sentence ("This computer didn't allow it."); anything else that
 * went wrong gets no reason rather than a programmer's one.
 */
export function refusal(wanted: boolean, error: unknown): string {
  const what = wanted ? "Couldn't turn this on." : "Couldn't turn this off.";
  const reason = typeof error === "string" ? error.trim() : "";
  return reason === "" ? what : `${what} ${reason}`;
}

/** The line Settings shows when it couldn't even ask. */
export function unanswered(error: unknown): string {
  const reason = typeof error === "string" ? error.trim() : "";
  const what = "Couldn't find out whether Linger starts when you sign in.";
  return reason === "" ? what : `${what} ${reason}`;
}

/** The note under the switch on a desktop that won't start Linger by itself. */
export function ignoredLine(desktop: string): string {
  const who = desktop.trim() === "" ? "This desktop" : desktop.trim();
  return `${who} doesn't start apps from the usual startup list by itself, so this switch may do nothing here. One line in its own startup settings does it.`;
}
