/**
 * What the composer does with a send that failed (SPEC §4.7 "Sending",
 * lessons L-16). Pure, so the rule that a newer draft is never touched is
 * tested, not hoped for.
 */
import type { MessageId } from "../../../generated/MessageId";

/** One press of Enter: what was sent, and where. */
export interface Submission {
  /** Unique in this composer, so a retry can't be fired twice. */
  key: number;
  /**
   * The send's one-time key (PROTOCOL §4, #524), the same on every retry of
   * it. A post the server saved, whose answer was lost on the way back, is
   * then answered with that message instead of posted a second time.
   */
  nonce: string;
  /** The conversation (tab) it was typed in. */
  conversation: string;
  body: string;
  replyTo: MessageId | null;
  /** The files that went with it, by the key the window holds them under. */
  fileKeys: string[];
}

/** What the composer holds right now, when a send comes back refused. */
export interface ComposerNow {
  /** The conversation showing. */
  conversation: string;
  draft: string;
  fileCount: number;
  replying: boolean;
}

/**
 * Put the failed text back in the box only when it is the same conversation's
 * box and it is untouched: empty, no files, not replying. Otherwise keep it
 * as a separate unsent message with a retry (shown in its own conversation),
 * and leave the newer draft exactly as it is.
 */
export function afterFailure(submission: Submission, now: ComposerNow): "restore" | "keep" {
  const untouched = now.draft === "" && now.fileCount === 0 && !now.replying;
  return untouched && submission.conversation === now.conversation ? "restore" : "keep";
}

/** Add a failed submission to the unsent list, once. */
export function keepUnsent(unsent: readonly Submission[], submission: Submission): Submission[] {
  return unsent.some((one) => one.key === submission.key) ? [...unsent] : [...unsent, submission];
}

/** A submission went through (first time or on retry). */
export function dropUnsent(unsent: readonly Submission[], key: number): Submission[] {
  return unsent.filter((one) => one.key !== key);
}

/**
 * The one-time key for what Enter sends now (#524). A failed send that went
 * back into the box (`afterFailure` "restore") and is sent again as it was is
 * the same send, retried, so it keeps its key; changed in any way, it's a new
 * message and gets a new one. `restored` is that failed send, if the box
 * holds one.
 */
export function nonceFor(
  next: Omit<Submission, "key" | "nonce">,
  restored: Submission | null,
  fresh: () => string,
): string {
  if (restored === null) return fresh();
  const files = (keys: readonly string[]) => JSON.stringify([...keys].sort());
  const same =
    restored.conversation === next.conversation &&
    restored.body === next.body &&
    restored.replyTo === next.replyTo &&
    files(restored.fileKeys) === files(next.fileKeys);
  return same ? restored.nonce : fresh();
}

/**
 * What Enter does with the box: send when there is something to send and no
 * file is still uploading. `blocked` says why not, in words, when it can't.
 */
export function canSend(draft: string, readyFiles: number, uploading: boolean): { ok: true } | { ok: false; blocked: string | null } {
  if (draft.trim().length === 0 && readyFiles === 0) return { ok: false, blocked: null };
  if (uploading) return { ok: false, blocked: "The file is still uploading. Your draft is kept here." };
  return { ok: true };
}
