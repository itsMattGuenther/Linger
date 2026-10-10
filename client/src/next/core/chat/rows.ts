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
 *
 * And one row the shared builder doesn't know: **somebody joining voice**
 * (#473). Join lines with nothing said between them, each within the group
 * break of the one before, are one row, "Jules and Dave joined voice", so a
 * raid filling up reads as one quiet line rather than forty.
 */
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import { buildRows } from "../../../lib/rows";
import { isQuietLine } from "../../../lib/quietLines";
import { GROUP_BREAK_MS } from "../../../lib/time";

export type ChatRow =
  /** A session break, labeled in natural words ("tonight"). */
  | { kind: "divider"; key: string; at: number }
  /** The "you left off here" line (SPEC §4.2). */
  | { kind: "left-off"; key: string }
  /**
   * One message. `head` means it opens a group and shows its author's name
   * inline; a continuation lines its words up under the head's.
   */
  | { kind: "message"; key: string; message: Message; head: boolean; pending: boolean }
  /**
   * Somebody joining voice (#473): one or more join lines, oldest first,
   * drawn as one quiet line. Keyed by the first, so the row keeps its
   * measured place as later joins add to it.
   */
  | { kind: "joins"; key: string; messages: Message[] };

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
  const rows: ChatRow[] = [];
  // The row just pushed was a line nobody typed (a message of the day, or a
  // join): what's said next isn't part of it, so it starts a group of its own.
  let afterLine = false;
  for (const row of buildRows([...messages, ...pending], options)) {
    if (row.kind !== "message") {
      rows.push(row);
      continue;
    }
    const { message } = row;
    if (message.voice_join === true) {
      // The app offers nobody a way to delete one; one taken back some other
      // way just isn't there, rather than a "deleted" with nothing to say.
      if (message.deleted_at !== null) continue;
      const last = rows[rows.length - 1];
      const joined = last?.kind === "joins" ? last.messages[last.messages.length - 1] : undefined;
      if (last?.kind === "joins" && joined !== undefined && message.created_at - joined.created_at <= GROUP_BREAK_MS) {
        last.messages.push(message);
      } else {
        rows.push({ kind: "joins", key: row.key, messages: [message] });
      }
      afterLine = true;
      continue;
    }
    const reply = message.reply_to !== null && message.deleted_at === null;
    // A message-of-the-day line says who set it on its own line (#464), a
    // poll always says who asked (#474), and a poll's closed line is a line
    // of its own; what's said after any of them isn't part of it, so each
    // starts a group of its own, and so does what follows.
    const apart = message.motd === true || (message.poll != null && message.deleted_at === null) || message.poll_closed != null;
    rows.push({
      kind: "message",
      key: row.key,
      message,
      head: row.head || reply || apart || afterLine,
      pending: waiting.has(message.id),
    });
    afterLine = apart;
  }
  return rows;
}

/** Where each message sits in the rows, for jumping to one. */
export function rowIndex(rows: readonly ChatRow[]): Map<MessageId, number> {
  const index = new Map<MessageId, number>();
  rows.forEach((row, at) => {
    if (row.kind === "message") index.set(row.message.id, at);
    else if (row.kind === "joins") for (const message of row.messages) index.set(message.id, at);
  });
  return index;
}

/**
 * The newest message you wrote and can still edit, for the composer's
 * Up-arrow. Only at the live end: inside a historical window the newest one
 * held is not the last thing you said. A line nobody typed is passed over: a
 * message-of-the-day line says what it was set to then (#464), and a join
 * line says somebody joined voice (#473); neither is edited.
 */
export function lastEditable(messages: readonly Message[], meId: string | null, atEnd: boolean): Message | null {
  if (!atEnd || meId === null) return null;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message && message.author_id === meId && message.deleted_at === null && !isQuietLine(message)) return message;
  }
  return null;
}
