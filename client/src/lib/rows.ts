/**
 * Messages in, rows out.
 *
 * The stream is not a list of messages — it is a list of *rows*, because a
 * session divider is a row, and because whether a message shows its author's
 * name depends on the message before it. Working that out here, once, keeps the
 * component down to "draw row N" and keeps the virtualizer's job simple: every
 * row has a stable key, so a row that was already measured stays measured when
 * older history is prepended above it.
 */
import type { Message } from "../generated/Message";
import type { MessageId } from "../generated/MessageId";
import { GROUP_BREAK_MS, SESSION_BREAK_MS } from "./time";

export type StreamRow =
  /** A session break: real whitespace and a soft labeled divider (SPEC §4.7). */
  | { kind: "divider"; key: string; at: number }
  /** The "you left off here" line (SPEC §4.2). This is what replaces the badge. */
  | { kind: "left-off"; key: string }
  /** One message. `head` means it opens a group and shows the author's name. */
  | { kind: "message"; key: string; message: Message; head: boolean };

export interface BuildOptions {
  /**
   * True when the oldest message here is the oldest the server has. Only then
   * does a divider above it mean anything — otherwise it would be labelling the
   * top of a page, not the start of a session.
   */
  atStart: boolean;
  /**
   * The newest message you had read when you walked in. The "you left off here"
   * line goes above the first message newer than this one.
   *
   * Null when there is nothing to mark: a room you have never opened, or one
   * you have read to the end of.
   */
  leftOff?: MessageId | null;
}

/** Build the rows for one room. `messages` must be oldest-first. */
export function buildRows(messages: readonly Message[], options: BuildOptions): StreamRow[] {
  const rows: StreamRow[] = [];
  let previous: Message | null = null;

  const leftOff = options.leftOff ?? null;
  let placed = leftOff === null;
  // The line can only be drawn once the message on the *older* side of it is
  // loaded, or there is nothing older to load. Otherwise it would sit at the
  // top of a page of history and claim that is where you stopped, when really
  // it is where the last fetch happened to end.
  let boundaryLoaded = options.atStart;

  for (const message of messages) {
    const gap = previous === null ? Number.POSITIVE_INFINITY : message.created_at - previous.created_at;
    const opensSession = previous === null ? options.atStart : gap > SESSION_BREAK_MS;
    const opensLeftOff = !placed && boundaryLoaded && leftOff !== null && message.id > leftOff;

    if (opensSession) {
      rows.push({ kind: "divider", key: `divider:${message.id}`, at: message.created_at });
    }
    // After the session divider and before the message: the session break is
    // about time passing, and "you left off here" is about this exact message.
    if (opensLeftOff) {
      rows.push({ kind: "left-off", key: `left-off:${message.id}` });
      placed = true;
    }
    if (leftOff !== null && message.id <= leftOff) boundaryLoaded = true;

    const head =
      previous === null ||
      opensSession ||
      // The first message you have not seen says who said it, even when the
      // same person was already talking. A run of unattributed lines under the
      // line is the one place grouping costs more than it saves.
      opensLeftOff ||
      previous.author_id !== message.author_id ||
      gap > GROUP_BREAK_MS;

    rows.push({ kind: "message", key: message.id, message, head });
    previous = message;
  }

  return rows;
}
