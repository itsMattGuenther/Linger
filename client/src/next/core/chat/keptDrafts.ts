/**
 * Half-typed messages, kept on this computer (decision 11): a conversation's
 * unfinished line is still there after its tab is closed or Linger restarts,
 * as it is in Discord or Slack, and gone once it's sent. Nothing leaves this
 * computer. A draft left alone for a month is let go, and so are the oldest
 * once there are more than a hundred.
 */
import type { DraftStore } from "../handoff";

const KEY = "linger.next.drafts";
/** A draft untouched this long is let go. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many conversations' drafts are kept. */
export const MAX_KEPT = 100;

interface Kept {
  text: string;
  at: number;
}

function read(store: DraftStore): Record<string, Kept> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const kept: Record<string, Kept> = {};
    for (const [conversation, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { text, at } = value as { text?: unknown; at?: unknown };
      if (typeof text === "string" && typeof at === "number") kept[conversation] = { text, at };
    }
    return kept;
  } catch {
    return {};
  }
}

/** The draft kept for a conversation, or "" if there's none. */
export function keptDraft(store: DraftStore, conversation: string, now: number): string {
  const kept = read(store)[conversation];
  return kept && now - kept.at < KEEP_MS ? kept.text : "";
}

/** Keep what a conversation's box holds now; an empty box keeps nothing. */
export function keepDraft(store: DraftStore, conversation: string, text: string, now: number): void {
  const kept = read(store);
  if (text.trim() === "") delete kept[conversation];
  else kept[conversation] = { text, at: now };
  const fresh = Object.entries(kept)
    .filter(([, draft]) => now - draft.at < KEEP_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_KEPT);
  try {
    if (fresh.length === 0) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    // Storage refused: the draft lasts as long as the window does.
  }
}
