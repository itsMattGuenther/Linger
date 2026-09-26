/**
 * A conversation's rows, as the chat window draws them
 * (docs/design/system.md, "The conversation").
 *
 * Built on the shared `buildRows` (sessions, the 10-minute group break, the
 * "you left off here" line), with the one change inline names need: **a
 * reply always opens a group.** Its quote sits above its own line, and a
 * quote above a line with no name would read as a quote of the line above.
 * So a reply shows who is replying, and gets a group's space above it, which
 * is also what keeps it off the message before (#181).
 */
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import { buildRows } from "../../../lib/rows";

export type ChatRow =
  /** A session break, labeled in natural words ("tonight"). */
  | { kind: "divider"; key: string; at: number }
  /** The "you left off here" line (SPEC §4.2). */
  | { kind: "left-off"; key: string }
  /**
   * One message. `head` means it opens a group and shows its author's name
   * inline; a continuation lines its words up under the head's.
   */
  | { kind: "message"; key: string; message: Message; head: boolean; pending: boolean };

export interface ChatRowOptions {
  /** The oldest message held is the oldest there is. */
  atStart: boolean;
  /** The newest message read when the conversation was opened. */
  leftOff: MessageId | null;
}

/**
 * Rows for a conversation: the confirmed messages, then the sends still
 * waiting on the server (drawn after, never mixed in).
 */
export function chatRows(
  messages: readonly Message[],
  pending: readonly Message[],
  options: ChatRowOptions,
): ChatRow[] {
  const waiting = new Set(pending.map((message) => message.id));
  return buildRows([...messages, ...pending], options).map((row): ChatRow => {
    if (row.kind !== "message") return row;
    const reply = row.message.reply_to !== null && row.message.deleted_at === null;
    return {
      kind: "message",
      key: row.key,
      message: row.message,
      head: row.head || reply,
      pending: waiting.has(row.message.id),
    };
  });
}

/** Where each message sits in the rows, for jumping to one. */
export function rowIndex(rows: readonly ChatRow[]): Map<MessageId, number> {
  const index = new Map<MessageId, number>();
  rows.forEach((row, at) => {
    if (row.kind === "message") index.set(row.message.id, at);
  });
  return index;
}

/**
 * The newest message you wrote and can still edit, for the composer's
 * Up-arrow. Only at the live end: inside a historical window the newest one
 * held is not the last thing you said.
 */
export function lastEditable(messages: readonly Message[], meId: string | null, atEnd: boolean): Message | null {
  if (!atEnd || meId === null) return null;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message && message.author_id === meId && message.deleted_at === null) return message;
  }
  return null;
}
