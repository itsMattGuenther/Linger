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
 * A character that draws something by itself, as the server judges it
 * (`validate::is_seen`): not a space, a control or format character such as a
 * zero-width space, a mark with no letter under it, or one of the letters that
 * are blank on purpose (the Hangul fillers, the empty braille cell, the
 * musical null notehead). An unassigned code point counts as seen: it is most
 * likely an emoji newer than this engine's tables.
 */
const SEEN = /[^\s\p{Cc}\p{Cf}\p{Z}\p{M}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{1D159}]/u;

/**
 * Whether a draft is as empty as one of spaces (#512). A message of only
 * blank letters would draw as an empty row, and the server refuses it with
 * the answer a blank one gets.
 */
export function saysNothing(draft: string): boolean {
  return !SEEN.test(draft);
}

/**
 * What Enter does with the box: send when there is something to send and no
 * file is still uploading. `blocked` says why not, in words, when it can't.
 */
export function canSend(draft: string, readyFiles: number, uploading: boolean): { ok: true } | { ok: false; blocked: string | null } {
  if (saysNothing(draft) && readyFiles === 0) return { ok: false, blocked: null };
  if (uploading) return { ok: false, blocked: "The file is still uploading. Your draft is kept here." };
  return { ok: true };
}
