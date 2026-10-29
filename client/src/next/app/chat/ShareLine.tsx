/**
 * The quiet line a room or DM gets when somebody shares their screen in its
 * voice (SPEC §4.20, #746): "Jules is sharing their screen · Watch" while
 * they are, then "Jules shared their screen" for good. The same grey as
 * somebody joining voice (#473), the name dim too, with the screen's glyph.
 * It says who, never what (hard rule 2), and calls nobody over: Watch is
 * there for whoever reads it, and joins voice first, as the voice line's
 * does.
 */
import { memo } from "react";
import type { Message } from "../../../generated/Message";
import type { User } from "../../../generated/User";
import { nameless } from "../../../lib/gone";
import { clockTime, fullTime, isoTime } from "../../../lib/time";
import { Icon, Name } from "../../kit";
import "./QuietLine.css";

/**
 * Where a share line stands: their share still going, with Watch when it's
 * somebody else's you aren't watching, or over (left out).
 */
export type ShareLineState = "live" | "watch";

export const ShareLine = memo(function ShareLine({
  message,
  person,
  gone,
  state,
  onWatch,
}: {
  message: Message;
  person: User | undefined;
  /** Deleted accounts (#650): a line about one names it so. */
  gone?: ReadonlySet<string>;
  state?: ShareLineState;
  /** Watch their share: joins voice first when you aren't in it. */
  onWatch: (person: string) => void;
}) {
  return (
    <div className="nx-quiet" data-share={state ?? "over"}>
      <p className="nx-quiet-words">
        <span className="nx-quiet-glyph">
          <Icon name="screen" size="sm" />
        </span>
        <span className="nx-quiet-text">
          {person ? <Name person={person} size="inline" dim /> : nameless(message.author_id, gone)}
          {state === undefined ? " shared their screen" : " is sharing their screen"}
          {state === "watch" ? (
            <>
              {" · "}
              <button type="button" className="nx-quiet-link" onClick={() => onWatch(message.author_id)}>
                Watch
              </button>
            </>
          ) : null}
        </span>
      </p>
      <time className="nx-msg-time" dateTime={isoTime(message.created_at)} title={fullTime(message.created_at)}>
        {clockTime(message.created_at)}
      </time>
    </div>
  );
});
