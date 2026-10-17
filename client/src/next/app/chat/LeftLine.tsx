/**
 * The quiet line a group DM gets when somebody leaves it (SPEC §4.13, #565):
 * "Callie left". The same grey as somebody joining voice (#473), the name
 * dim too, with the leave glyph where a join has the voice one. It says who
 * can't read the conversation any more; it never calls anybody over.
 */
import { memo } from "react";
import type { Message } from "../../../generated/Message";
import type { User } from "../../../generated/User";
import { nameless } from "../../../lib/gone";
import { clockTime, fullTime } from "../../../lib/time";
import { Icon, Name } from "../../kit";
import "./QuietLine.css";

export const LeftLine = memo(function LeftLine({
  message,
  person,
  gone,
}: {
  message: Message;
  person: User | undefined;
  /** Deleted accounts (#650): one leaves its group DMs as it goes. */
  gone?: ReadonlySet<string>;
}) {
  return (
    <div className="nx-quiet" data-left="">
      <p className="nx-quiet-words">
        <span className="nx-quiet-glyph">
          <Icon name="leave" size="sm" />
        </span>
        <span className="nx-quiet-text">
          {person ? <Name person={person} size="inline" dim /> : nameless(message.author_id, gone)} left
        </span>
      </p>
      <time className="nx-msg-time" dateTime={new Date(message.created_at).toISOString()} title={fullTime(message.created_at)}>
        {clockTime(message.created_at)}
      </time>
    </div>
  );
});
