import { memo, useEffect, useReducer } from "react";
import type { User } from "../../../generated/User";
import { joinList, verbFor } from "../../core/chat/words";
import { Name } from "../../kit";
import "./Typing.css";

/** Who is writing at a moment, and when that next changes by itself (null: only when somebody starts). */
export interface TypingNow {
  people: readonly User[];
  until: number | null;
}

/**
 * Who is writing, above the message box (CONV-20). The line keeps its space
 * whether or not anyone types, so the box never jumps while you aim at it.
 * Names in their own style, dots in their color.
 *
 * Nobody says they've stopped typing; each "is typing" runs out. The line
 * asks again when the next one does, and only then: no clock while nobody
 * types, and only this line is drawn again, not the window (#511).
 */
export const Typing = memo(function Typing({ typing }: { typing: (now: number) => TypingNow }) {
  const [draws, drawAgain] = useReducer((count: number) => count + 1, 0);
  const { people, until } = typing(Date.now());
  // Keyed on the draw too: a timer that fires a moment early is set again.
  useEffect(() => {
    if (until === null) return;
    const timer = window.setTimeout(drawAgain, until - Date.now());
    return () => window.clearTimeout(timer);
  }, [until, draws]);
  const parts = joinList(people);
  return (
    <p className="nx-typing" aria-live="polite">
      {people.length === 0 ? null : (
        <>
          <span className="nx-typing-words">
            {parts.map((part, index) =>
              "item" in part ? <Name key={part.item.id} person={part.item} size="inline" /> : <span key={index}>{part.text}</span>,
            )}{" "}
            {verbFor(people.length, "is", "are")} typing
          </span>
          <span className="nx-typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </>
      )}
    </p>
  );
});
