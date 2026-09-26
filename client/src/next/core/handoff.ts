/**
 * A half-typed message travelling with its conversation from one window to
 * another: popped out of the tabs, or back into them (docs/design/buddy-list.md,
 * "Conversations: tabs or windows"). The window it leaves writes it down; the
 * window it arrives in takes it, once. Every Linger window shares this
 * computer's storage, and nothing leaves it.
 *
 * A draft nobody takes within a minute is stale (the other window never
 * opened) and is thrown away rather than surprising someone later.
 */

/** The part of `Storage` this needs, so tests can hand it a plain one. */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "linger.next.handoff.";
/** How long a draft waits for its window. */
export const HANDOFF_MS = 60_000;

/** Leave a draft for the window this conversation is moving to. Nothing to leave, nothing written. */
export function leaveDraft(store: DraftStore, conversation: string, text: string, now: number): void {
  try {
    if (text.trim() === "") store.removeItem(PREFIX + conversation);
    else store.setItem(PREFIX + conversation, JSON.stringify({ text, at: now }));
  } catch {
    // Storage refused: the conversation moves without its draft.
  }
}

/** Take the draft left for this conversation, if there is a fresh one. It is gone afterwards. */
export function takeDraft(store: DraftStore, conversation: string, now: number): string | null {
  let stored: string | null = null;
  try {
    stored = store.getItem(PREFIX + conversation);
    if (stored !== null) store.removeItem(PREFIX + conversation);
  } catch {
    return null;
  }
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || !("text" in parsed) || !("at" in parsed)) return null;
    const { text, at } = parsed;
    if (typeof text !== "string" || typeof at !== "number" || now - at > HANDOFF_MS || at > now + HANDOFF_MS) return null;
    return text;
  } catch {
    return null;
  }
}
