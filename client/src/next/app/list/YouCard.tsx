import { useRef, useState } from "react";
import type { MeCard } from "../../core/list";
import { lineProblem } from "../../core/you";
import { Button, Icon, Marker, MARKER_WORDS, markerStateOf, Name, TextField } from "../../kit";
import { markerFor } from "../markers";
import { AwayEditor } from "./AwayEditor";
import "./YouCard.css";

/** What the list's top card can change, each answering with a problem in words, or null. */
export interface YouActions {
  saveLine: (line: string) => Promise<string | null>;
  goAway: (message: string) => Promise<string | null>;
  comeBack: () => Promise<string | null>;
  /** Away messages to offer, your own recent ones first. */
  awayChoices: string[];
}

/**
 * You, at the top of the list (docs/design/buddy-list.md): your name in your
 * own style, where you are, your status line (click to change it), and Away,
 * which opens the away-message editor, or I'm back when you are away.
 */
export function YouCard({ me, actions }: { me: MeCard; actions?: YouActions }) {
  const status = me.user.status;
  const awayMessage = status?.away_message ?? null;
  const away = awayMessage !== null && awayMessage !== "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awayOpen, setAwayOpen] = useState<{ top: number; bottom: number } | null>(null);
  const lineButton = useRef<HTMLButtonElement | null>(null);
  const awayButton = useRef<HTMLDivElement | null>(null);

  const startEditing = () => {
    setDraft(status?.line ?? "");
    setProblem(null);
    setEditing(true);
  };
  const stopEditing = () => {
    setEditing(false);
    setProblem(null);
    // Back to where you were, for the keyboard.
    requestAnimationFrame(() => lineButton.current?.focus());
  };
  const save = async () => {
    if (!actions || busy) return;
    const tooLong = lineProblem(draft);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    setBusy(true);
    const refused = await actions.saveLine(draft);
    setBusy(false);
    if (refused) setProblem(refused);
    else stopEditing();
  };

  return (
    <section className="nx-you" aria-label="You">
      <div className="nx-you-top">
        <div className="nx-you-who">
          <Name person={me.user} size="display" />
          <span className="nx-you-where">
            <Marker {...markerFor(me.user, me.state)} size="sm" label={MARKER_WORDS[markerStateOf(me.state)]} />
            <span className="nx-you-text">{me.where}</span>
          </span>
        </div>
        {actions ? (
          <div ref={awayButton}>
            {away ? (
              <Button size="sm" variant="secondary" icon="sun" busy={busy} onClick={() => void comeBack()}>
                I'm back
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon="moon"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setAwayOpen({ top: box.top, bottom: box.bottom });
                }}
              >
                Away
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {away ? (
        <p className="nx-you-away">“{awayMessage}”</p>
      ) : editing ? (
        <div
          className="nx-you-edit"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              stopEditing();
            }
          }}
        >
          <TextField
            label="Your status"
            hideLabel
            value={draft}
            onChange={setDraft}
            placeholder="What's up?"
            size="sm"
            italic
            autoFocus
            error={problem ?? undefined}
            onEnter={() => void save()}
          />
        </div>
      ) : (
        <button
          ref={lineButton}
          type="button"
          className="nx-you-line"
          aria-label={status?.line ? `Your status: ${status.line}. Change it` : "Set a status"}
          disabled={!actions}
          onClick={startEditing}
        >
          <Icon name="pencil" size="sm" />
          <span className="nx-you-line-text" data-empty={status?.line ? undefined : "yes"}>
            {status?.line ?? "Set a status"}
          </span>
        </button>
      )}

      {awayOpen && actions ? (
        <AwayEditor
          me={me.user}
          anchor={awayOpen}
          choices={actions.awayChoices}
          onCancel={() => {
            setAwayOpen(null);
            requestAnimationFrame(() => awayButton.current?.querySelector("button")?.focus());
          }}
          onGoAway={async (message) => {
            const refused = await actions.goAway(message);
            if (refused === null) setAwayOpen(null);
            return refused;
          }}
        />
      ) : null}
    </section>
  );

  async function comeBack() {
    if (!actions || busy) return;
    setBusy(true);
    await actions.comeBack();
    setBusy(false);
  }
}
