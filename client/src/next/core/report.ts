/**
 * A chat window telling the owner what presence needs
 * (docs/design/architecture.md, "Windows and their roles"; lib/watchPresence):
 * whether it has focus, that the person is typing or moving in it, which
 * conversation it shows, and that it is closing. The owner's presence
 * watcher does the deciding; this only reports.
 */
import type { RoomId } from "../../generated/RoomId";
import type { Intent } from "./share";

/** Input is reported at most this often: presence counts in minutes, not keystrokes. */
export const INPUT_EVERY_MS = 15_000;

/** What the reporter needs from a window, so tests can hand it a fake one. */
export interface ReportTarget {
  hasFocus(): boolean;
  addEventListener(type: string, listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface Reporter {
  /** The conversation now on screen in this window, or none. */
  showing(server: string, roomId: RoomId | null): void;
  /** The window is closing: say so, and stop listening. */
  stop(): void;
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
const FOCUS_EVENTS = ["focus", "blur", "visibilitychange"] as const;

export function startReporting(
  intend: (intent: Intent) => Promise<void>,
  target: ReportTarget,
  now: () => number = Date.now,
): Reporter {
  let focused = target.hasFocus();
  let inputAt = -Infinity;
  let shown: { server: string; roomId: RoomId | null } | null = null;
  const say = (intent: Intent) => void intend(intent).catch(() => undefined);

  const onFocus = () => {
    const next = target.hasFocus();
    if (next === focused) return;
    focused = next;
    // Gaining focus is the person arriving: it counts as input, as it does in
    // the list window (lib/watchPresence, syncFocus).
    if (next) inputAt = now();
    say({ kind: "window", focused: next, input: next });
  };
  const onInput = () => {
    const at = now();
    if (at - inputAt < INPUT_EVERY_MS) return;
    inputAt = at;
    focused = target.hasFocus();
    say({ kind: "window", focused, input: true });
  };

  for (const type of FOCUS_EVENTS) target.addEventListener(type, onFocus);
  for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, { passive: true });
  say({ kind: "window", focused, input: focused });

  return {
    showing(server, roomId) {
      if (shown !== null && shown.server === server && shown.roomId === roomId) return;
      shown = { server, roomId };
      say({ kind: "room", server, roomId });
    },
    stop() {
      for (const type of FOCUS_EVENTS) target.removeEventListener(type, onFocus);
      for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput);
      say({ kind: "closing" });
    },
  };
}

/** The real window: focused only when it has focus and is on screen. */
export function windowTarget(): ReportTarget {
  return {
    hasFocus: () => document.hasFocus() && document.visibilityState === "visible",
    addEventListener: (type, listener, options) =>
      (type === "visibilitychange" ? document : window).addEventListener(type, listener, options),
    removeEventListener: (type, listener) =>
      (type === "visibilitychange" ? document : window).removeEventListener(type, listener),
  };
}
