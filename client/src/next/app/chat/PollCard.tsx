/**
 * A poll in the conversation (SPEC §4.18, #474): what Matt picked as
 * "option 1" (2026-10-10). Each choice is a row with a neutral fill behind
 * it for its share, never the lamp, and its voters' dots at its end, each
 * with its person's name; past sixteen dots the people mark lists everybody
 * who picked it. Never a number: the dots and the fill say it.
 *
 * Everybody in the room votes, whoever asked included, and changes or takes
 * back their vote as often as they like until it closes. Pick-one has round
 * boxes, pick-any square ones, and yours is ticked. Only whoever asked has
 * Close poll; every poll closes on its own anyway. Closed, there are no
 * boxes and the winner is bold.
 */
import { memo, useRef, useState } from "react";
import type { Message } from "../../../generated/Message";
import type { Poll } from "../../../generated/Poll";
import type { User } from "../../../generated/User";
import { closesWhen, setWhen } from "../../../lib/time";
import { nextVote, pollOpen, votesOf } from "../../core/chat/poll";
import { Button, Icon, IconButton, Marker } from "../../kit";
import { markerFor } from "../markers";
import { PeopleCard } from "./PeopleCard";
import "./PollCard.css";

/** Dots shown on a choice before the people mark takes over. */
const DOTS = 16;

export interface PollActions {
  /** Your vote becomes these choices; empty takes it back. Rejects with a sentence. */
  vote: (message: Message, choices: number[]) => Promise<void>;
  /** Close it now: only whoever asked is offered this. Rejects with a sentence. */
  closePoll: (message: Message) => Promise<void>;
}

export const PollCard = memo(function PollCard({
  message,
  poll,
  people,
  me,
  now,
  actions,
}: {
  message: Message;
  poll: Poll;
  people: ReadonlyMap<string, User>;
  me: User | null;
  now: number;
  actions: PollActions;
}) {
  // A vote on its way shows at once; the poll the server sends back replaces it.
  const [sending, setSending] = useState<number[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [everyone, setEveryone] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const open = pollOpen(poll, now);
  const mine = sending ?? votesOf(poll, me?.id ?? null);
  const asked = me !== null && message.author_id === me.id;
  const voters = new Set(poll.choices.flatMap((choice) => choice.voter_ids)).size;
  const most = Math.max(0, ...poll.choices.map((choice) => choice.voter_ids.length));

  const pick = (at: number) => {
    const next = nextVote(poll, mine, at);
    setSending(next);
    setProblem(null);
    actions
      .vote(message, next)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : "Couldn't vote. Try again."))
      .finally(() => setSending(null));
  };

  const close = () => {
    setClosing(true);
    setProblem(null);
    actions
      .closePoll(message)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : "Couldn't close the poll. Try again."))
      .finally(() => setClosing(false));
  };

  const closer = poll.closed_by === null ? undefined : people.get(poll.closed_by);
  const foot = !open
    ? poll.closed_at === null
      ? "Closing now."
      : poll.closed_by === null
        ? `Closed on its own ${setWhen(poll.closed_at, now)}.`
        : `Closed by ${closer?.display_name ?? "whoever asked"} ${setWhen(poll.closed_at, now)}.`
    : `Closes ${closesWhen(poll.closes_at, now)}.`;

  return (
    <div className="nx-poll" data-closed={open ? undefined : "yes"}>
      <p className="nx-poll-head">
        <span className="nx-poll-label">Poll</span>
        <span className="nx-poll-how">{open ? (poll.multi ? "pick any" : "pick one") : "closed"}</span>
      </p>
      <p className="nx-poll-question">{poll.question}</p>
      <ul className="nx-poll-choices" role={open ? (poll.multi ? "group" : "radiogroup") : undefined} aria-label={poll.question}>
        {poll.choices.map((choice, at) => {
          const picked = mine.includes(at);
          const who = choice.voter_ids.flatMap((id) => people.get(id) ?? []);
          const share = voters === 0 ? 0 : (choice.voter_ids.length / voters) * 100;
          const lead = !open && most > 0 && choice.voter_ids.length === most;
          const words = (
            <>
              {open ? (
                <span className="nx-poll-box" data-round={poll.multi ? undefined : "yes"} aria-hidden="true">
                  {picked ? <Icon name="check" size="sm" /> : null}
                </span>
              ) : null}
              <span className="nx-poll-text">{choice.text}</span>
            </>
          );
          return (
            <li key={at} className="nx-poll-choice" data-picked={picked ? "yes" : undefined} data-lead={lead ? "yes" : undefined}>
              <span className="nx-poll-fill" style={{ inlineSize: `${share}%` }} aria-hidden="true" />
              {open ? (
                <button
                  type="button"
                  className="nx-poll-pick"
                  role={poll.multi ? "checkbox" : "radio"}
                  aria-checked={picked}
                  onClick={() => pick(at)}
                >
                  {words}
                </button>
              ) : (
                <span className="nx-poll-pick">{words}</span>
              )}
              <span className="nx-poll-who">
                <span className="nx-poll-dots" aria-hidden="true">
                  {who.slice(0, DOTS).map((person) => (
                    <span key={person.id} className="nx-poll-dot" title={person.display_name}>
                      <Marker {...markerFor(person, "in_room")} size="sm" />
                    </span>
                  ))}
                </span>
                <span className="k-sr-only">{who.length === 0 ? "nobody yet" : who.map((person) => person.display_name).join(", ")}</span>
                {who.length > DOTS ? (
                  <IconButton
                    icon="people"
                    label={`Everyone who picked ${choice.text}`}
                    size="sm"
                    expanded={everyone === at}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setEveryone((shown) => (shown === at ? null : at));
                    }}
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="nx-poll-foot">
        <span className="nx-poll-note">{foot}</span>
        {open && asked ? (
          <Button size="sm" variant="quiet" busy={closing} onClick={close}>
            Close poll
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p className="nx-poll-problem" role="alert">
          {problem}
        </p>
      ) : null}
      {everyone !== null ? (
        <PeopleCard
          heading={`Picked ${poll.choices[everyone]?.text ?? ""}`}
          label={`Everyone who picked ${poll.choices[everyone]?.text ?? ""}`}
          people={(poll.choices[everyone]?.voter_ids ?? []).flatMap((id) => people.get(id) ?? [])}
          anchor={opener}
          onClose={() => setEveryone(null)}
        />
      ) : null}
    </div>
  );
});
