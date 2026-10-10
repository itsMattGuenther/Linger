/**
 * The quiet line a room or DM gets when somebody joins its voice (SPEC §4.14,
 * #473): "Jules joined voice". All grey, the names too: Matt picked the
 * quietest of three (2026-10-10), so it never competes with what people say.
 *
 * A run of joins with nothing said between them is one line
 * (`core/chat/rows.ts`). Up to four people are named. Past that the first
 * three are, and everybody else is a dot in their own color with their name
 * on it; past sixteen dots the people mark lists everybody, as a poll's
 * choice does. Never "and 31 more": a tally of people is the shape SPEC §2
 * took out.
 */
import { memo, useRef, useState } from "react";
import type { Message } from "../../../generated/Message";
import type { User } from "../../../generated/User";
import { clockTime, fullTime } from "../../../lib/time";
import { IconButton, Marker, Name, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import { PeopleCard } from "./PeopleCard";
import "./JoinLine.css";

/** Named when there are more than `NAMED + 1`; the rest are dots. */
const NAMED = 3;
/** Dots shown before the people mark takes over. */
const DOTS = 16;

export const JoinLine = memo(function JoinLine({ messages, people }: { messages: readonly Message[]; people: ReadonlyMap<string, User> }) {
  const [everyone, setEveryone] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const first = messages[0];
  if (first === undefined) return null;
  // Each person once, in the order they joined.
  const ids = [...new Set(messages.map((message) => message.author_id))];
  const named = ids.length <= NAMED + 1 ? ids : ids.slice(0, NAMED);
  const rest = ids.slice(named.length).flatMap((id) => people.get(id) ?? []);
  const known = ids.flatMap((id) => people.get(id) ?? []);

  const names = named.map((id, at) => {
    const person = people.get(id);
    const name = person ? <Name person={person} size="inline" dim /> : "someone";
    const joiner = at === 0 ? null : at === named.length - 1 && rest.length === 0 ? " and " : ", ";
    return (
      <span key={id}>
        {joiner}
        {name}
      </span>
    );
  });

  return (
    <div className="nx-join" data-join="">
      <p className="nx-join-words">
        <span className="nx-join-glyph">
          <VoiceGlyph speaking={false} />
        </span>
        <span className="nx-join-who">
          {names}
          {rest.length > 0 ? (
            <>
              {" and "}
              <span className="nx-join-dots" aria-hidden="true">
                {rest.slice(0, DOTS).map((person) => (
                  <span key={person.id} className="nx-join-dot" title={person.display_name}>
                    <Marker {...markerFor(person, "in_room")} size="sm" />
                  </span>
                ))}
              </span>
              <span className="k-sr-only">{rest.map((person) => person.display_name).join(", ")}</span>
              {rest.length > DOTS ? (
                <span className="nx-join-more">
                  <IconButton
                    icon="people"
                    label="Everyone who joined voice"
                    size="sm"
                    expanded={everyone}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setEveryone((open) => !open);
                    }}
                  />
                </span>
              ) : null}
            </>
          ) : null}{" "}
          joined voice
        </span>
      </p>
      <time className="nx-msg-time" dateTime={new Date(first.created_at).toISOString()} title={fullTime(first.created_at)}>
        {clockTime(first.created_at)}
      </time>
      {everyone ? (
        <PeopleCard heading="Joined voice" label="Everyone who joined voice" people={known} anchor={opener} onClose={() => setEveryone(false)} />
      ) : null}
    </div>
  );
});
