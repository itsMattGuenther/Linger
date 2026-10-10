/**
 * Asking a poll (SPEC §4.18, #474): the panel `/poll` opens over a room's box,
 * as a voice message's does. The question, two to ten choices, whether people
 * can pick more than one, and how long it runs before it closes on its own.
 * Nothing is posted until Post poll.
 */
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CreatePollRequest } from "../../../generated/CreatePollRequest";
import {
  DEFAULT_POLL_LENGTH,
  MAX_POLL_CHOICE_CHARS,
  MAX_POLL_CHOICES,
  MAX_POLL_QUESTION_CHARS,
  MIN_POLL_CHOICES,
  POLL_LENGTHS,
  type PollLength,
} from "../../core/chat/poll";
import { Button, IconButton, Select, Switch, TextField } from "../../kit";
import "./PollPanel.css";

export function PollPanel({
  title,
  question: asked,
  onPost,
  onCancel,
}: {
  /** "#general". */
  title: string;
  /** What was typed after `/poll`, if anything. */
  question: string;
  /** Rejects with a sentence; the panel stays as it was. */
  onPost: (request: CreatePollRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState(asked);
  const [choices, setChoices] = useState<string[]>(["", ""]);
  const [multi, setMulti] = useState(false);
  const [length, setLength] = useState<PollLength>(DEFAULT_POLL_LENGTH);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  // Typing straight on: the question when there isn't one yet, else the first choice.
  useEffect(() => {
    const fields = panel.current?.querySelectorAll<HTMLInputElement>("input[type='text']");
    fields?.[asked.trim() === "" ? 0 : 1]?.focus();
  }, [asked]);

  // At once, not on the next frame: whatever is typed after Enter belongs in the next field.
  const focusChoice = (at: number) => panel.current?.querySelectorAll<HTMLInputElement>("input[type='text']")[at + 1]?.focus();
  const setChoice = (at: number, text: string) => setChoices((all) => all.map((one, n) => (n === at ? text : one)));
  const add = () => {
    if (choices.length >= MAX_POLL_CHOICES) return;
    flushSync(() => setChoices((all) => [...all, ""]));
    focusChoice(choices.length);
  };
  const remove = (at: number) => setChoices((all) => all.filter((_, n) => n !== at));

  const filled = choices.map((choice) => choice.trim()).filter((choice) => choice !== "");
  const why =
    question.trim() === ""
      ? "Ask a question first."
      : filled.length < MIN_POLL_CHOICES
        ? `A poll needs at least ${MIN_POLL_CHOICES} choices.`
        : new Set(filled.map((choice) => choice.toLowerCase())).size < filled.length
          ? "Each choice can only be there once."
          : null;

  const post = () => {
    if (why !== null || posting) return;
    setPosting(true);
    setProblem(null);
    onPost({ question: question.trim(), choices: filled, multi, closes_in_days: Number(length) })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : "Couldn't post the poll. Try again."))
      .finally(() => setPosting(false));
  };

  return (
    <div
      ref={panel}
      className="nx-poll-panel"
      role="group"
      aria-label={`New poll in ${title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="nx-poll-panel-head">
        <span className="nx-poll-panel-title">New poll in {title}</span>
        <IconButton icon="close" label="Close the poll" size="sm" onClick={onCancel} />
      </div>
      <TextField label="Question" value={question} onChange={setQuestion} maxLength={MAX_POLL_QUESTION_CHARS} onEnter={() => focusChoice(0)} />
      <div className="nx-poll-panel-choices" role="group" aria-label="Choices">
        <span className="k-field-label" aria-hidden="true">
          Choices
        </span>
        {choices.map((choice, at) => (
          <div className="nx-poll-panel-choice" key={at}>
            <TextField
              label={`Choice ${at + 1}`}
              hideLabel
              value={choice}
              onChange={(text) => setChoice(at, text)}
              maxLength={MAX_POLL_CHOICE_CHARS}
              onEnter={() => (at === choices.length - 1 ? add() : focusChoice(at + 1))}
            />
            <IconButton
              icon="close"
              label={`Remove choice ${at + 1}`}
              size="md"
              unavailable={choices.length <= MIN_POLL_CHOICES ? `A poll needs at least ${MIN_POLL_CHOICES} choices.` : undefined}
              onClick={() => remove(at)}
            />
          </div>
        ))}
        <div className="nx-poll-panel-add">
          <Button
            size="sm"
            variant="quiet"
            icon="plus"
            unavailable={choices.length >= MAX_POLL_CHOICES ? `A poll has at most ${MAX_POLL_CHOICES} choices.` : undefined}
            onClick={add}
          >
            Add a choice
          </Button>
        </div>
      </div>
      <div className="nx-poll-panel-row">
        <span className="nx-poll-panel-option">
          <Switch checked={multi} onChange={setMulti} label="People can pick more than one" />
          <span className="nx-poll-panel-words" aria-hidden="true">
            People can pick more than one
          </span>
        </span>
        <span className="nx-poll-panel-option">
          <span className="nx-poll-panel-words" aria-hidden="true">
            Closes after
          </span>
          <span className="nx-poll-panel-length">
            <Select label="Closes after" hideLabel size="sm" value={length} onChange={setLength} options={POLL_LENGTHS} />
          </span>
        </span>
      </div>
      <div className="nx-poll-panel-row nx-poll-panel-actions">
        {problem ?? why ? (
          <span className="nx-poll-panel-why" role={problem ? "alert" : undefined} data-problem={problem ? "yes" : undefined}>
            {problem ?? why}
          </span>
        ) : null}
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" busy={posting} unavailable={why ?? undefined} onClick={post}>
          Post poll
        </Button>
      </div>
    </div>
  );
}
