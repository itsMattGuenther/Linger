/**
 * How conversations open (docs/design/buddy-list.md, "Conversations: tabs or
 * windows"): as tabs in one chat window, the default, or each in a window of
 * its own. A choice about this computer, kept on it; the list window (the
 * owner) applies it and tells the other windows when it changes.
 */

export type ConversationsMode = "tabs" | "windows";

/** The part of `Storage` this needs, so tests can hand it a plain one. */
export interface ModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "linger.next.conversations";

/** Tabs unless windows was chosen; anything unreadable is the default. */
export function loadMode(store: ModeStore | null): ConversationsMode {
  try {
    return store?.getItem(KEY) === "windows" ? "windows" : "tabs";
  } catch {
    return "tabs";
  }
}

export function saveMode(store: ModeStore | null, mode: ConversationsMode): void {
  try {
    store?.setItem(KEY, mode);
  } catch {
    // Storage refused: the choice holds until the app closes.
  }
}

/** A choice that arrived over the bus or out of storage, checked. */
export function isMode(value: unknown): value is ConversationsMode {
  return value === "tabs" || value === "windows";
}
