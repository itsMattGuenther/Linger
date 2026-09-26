/**
 * The chat window's keyboard shortcuts (docs/design/buddy-list.md,
 * "Conversations: tabs or windows"; parity KEY-1): what a key press asks
 * for, decided without a window so every combination is tested. The desktop
 * app has no browser around it, so it takes the Ctrl keys a browser would
 * keep for itself.
 */

/** The parts of a key press that matter here (a `KeyboardEvent` has them all). */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type TabCommand =
  | { kind: "step"; by: 1 | -1 }
  /** Move the showing tab one place along the row. */
  | { kind: "move"; by: 1 | -1 }
  | { kind: "close" }
  /** A tab by its place, from 0; `last` for the ninth key, as browsers do. */
  | { kind: "jump"; to: number | "last" };

/** Ctrl+K opens Search from any window, or puts the cursor back in its box (SPEC §4.12). */
export function isSearchKey(press: KeyPress): boolean {
  return press.ctrlKey && !press.altKey && !press.metaKey && !press.shiftKey && (press.key === "k" || press.key === "K");
}

/** Ctrl+, opens Settings from any window (docs/design/buddy-list.md, "Settings"). */
export function isSettingsKey(press: KeyPress): boolean {
  return press.ctrlKey && !press.altKey && !press.metaKey && !press.shiftKey && press.key === ",";
}

/**
 * Ctrl+Tab and Ctrl+PageDown: the next tab; with Shift, or Ctrl+PageUp, the
 * one before. Ctrl+Shift+PageDown and PageUp move the showing tab along the
 * row, as browsers do. Ctrl+W closes the showing tab. Alt+1…8 jump to that
 * tab, Alt+9 to the last. Anything else is not a tab command.
 */
export function tabCommand(press: KeyPress): TabCommand | null {
  if (press.metaKey) return null;
  if (press.ctrlKey && !press.altKey) {
    if (press.key === "Tab") return { kind: "step", by: press.shiftKey ? -1 : 1 };
    if (press.shiftKey) {
      if (press.key === "PageDown") return { kind: "move", by: 1 };
      if (press.key === "PageUp") return { kind: "move", by: -1 };
      return null;
    }
    if (press.key === "PageDown") return { kind: "step", by: 1 };
    if (press.key === "PageUp") return { kind: "step", by: -1 };
    if (press.key === "w" || press.key === "W") return { kind: "close" };
    return null;
  }
  if (press.altKey && !press.ctrlKey && !press.shiftKey && /^[1-9]$/.test(press.key)) {
    const place = Number(press.key);
    return { kind: "jump", to: place === 9 ? "last" : place - 1 };
  }
  return null;
}
