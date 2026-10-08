/**
 * A room's message of the day (SPEC §4.1, #464): what's happening now, set
 * by the host or a co-host with `/motd` in the room's own box, and shown
 * whole under the room's header until you fold it to a line.
 *
 * Folding is yours, on this device. It's kept by the moment the message was
 * set, so a new one opens again for everybody who folded the last.
 */
import type { DraftStore } from "../handoff";

/** `linger-core::limits::MAX_MOTD_CHARS`, mirrored to refuse a long one before it's sent. */
export const MAX_MOTD_CHARS = 300;

const COMMAND = "/motd";

/**
 * The box read as `/motd`: the message to set, `""` to clear it, or null when
 * it's an ordinary message. `/motdx` is a word that starts the same, not the
 * command, and anything else starting with `/` is sent as typed.
 */
export function motdCommand(draft: string): string | null {
  const text = draft.trim();
  if (text.slice(0, COMMAND.length).toLowerCase() !== COMMAND) return null;
  const rest = text.slice(COMMAND.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  return rest.trim();
}

/**
 * The box is on its way to `/motd`, or holds it: the line over the box says
 * what it does. From `/m` on, so a lone `/`, or `/shrug`, isn't taken for it.
 */
export function typingMotd(draft: string): boolean {
  if (motdCommand(draft) !== null) return true;
  const start = draft.trimStart().toLowerCase();
  return start.length >= 2 && !/\s/.test(start) && COMMAND.startsWith(start);
}

const FOLDED_KEY = "linger.next.motdFolded";
/** At most this many rooms' folds are kept; the longest untouched go first. */
export const MAX_FOLDS = 200;

function readFolds(store: DraftStore): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(FOLDED_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const folds: Record<string, number> = {};
    for (const [conversation, setAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof setAt === "number") folds[conversation] = setAt;
    }
    return folds;
  } catch {
    return {};
  }
}

/** Whether this conversation's message of the day, set at `setAt`, is folded on this device. */
export function motdFolded(store: DraftStore | null, conversation: string, setAt: number): boolean {
  return store !== null && readFolds(store)[conversation] === setAt;
}

/** Fold this message of the day to a line on this device, or open it again. */
export function foldMotd(store: DraftStore | null, conversation: string, setAt: number, folded: boolean): void {
  if (store === null) return;
  const folds = readFolds(store);
  delete folds[conversation];
  if (folded) folds[conversation] = setAt;
  const kept = Object.entries(folds).slice(-MAX_FOLDS);
  try {
    if (kept.length === 0) store.removeItem(FOLDED_KEY);
    else store.setItem(FOLDED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage refused: the fold lasts as long as the window does.
  }
}
