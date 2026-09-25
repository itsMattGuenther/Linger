import { memo } from "react";
import type { User } from "../../../generated/User";
import { joinList, verbFor } from "../../core/chat/words";
import { Name } from "../../kit";
import "./Typing.css";

/**
 * Who is writing, above the message box (CONV-20). The line keeps its space
 * whether or not anyone types, so the box never jumps while you aim at it.
 * Names in their own style, dots in their color.
 */
export const Typing = memo(function Typing({ people }: { people: readonly User[] }) {
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
