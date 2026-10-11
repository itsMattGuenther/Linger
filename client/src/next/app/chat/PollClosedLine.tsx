/**
 * The line a room gets when one of its polls closes (SPEC §4.18, #474):
 * "Poll closed: “Which faction…?” Horde won. See results". The same quiet
 * grey as somebody joining voice, at the bottom where people are reading,
 * because after a fortnight the poll itself is a long way up. See results
 * jumps to it and marks it for a moment, as a reply's quote does.
 */
import { memo } from "react";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { PollClosed } from "../../../generated/PollClosed";
import { clockTime, fullTime, isoTime } from "../../../lib/time";
import { resultWords } from "../../core/chat/poll";
import { Icon } from "../../kit";
import "./QuietLine.css";

export const PollClosedLine = memo(function PollClosedLine({
  message,
  closed,
  onJump,
}: {
  message: Message;
  closed: PollClosed;
  onJump: (id: MessageId) => void;
}) {
  return (
    <div className="nx-quiet" data-poll-closed="">
      <p className="nx-quiet-words">
        <span className="nx-quiet-glyph">
          <Icon name="check" size="sm" />
        </span>
        <span className="nx-quiet-text">
          Poll closed: “{closed.question}” {resultWords(closed.winners)}{" "}
          <button type="button" className="nx-quiet-link" onClick={() => onJump(closed.poll_id)}>
            See results
          </button>
        </span>
      </p>
      <time className="nx-msg-time" dateTime={isoTime(message.created_at)} title={fullTime(message.created_at)}>
        {clockTime(message.created_at)}
      </time>
    </div>
  );
});
