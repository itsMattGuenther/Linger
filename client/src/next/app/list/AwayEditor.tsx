import { useLayoutEffect, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { Button, Marker, Name, Popover, TextField } from "../../kit";
import { markerFor } from "../markers";
import "./AwayEditor.css";

/**
 * The away message (SPEC §4.6, "the AIM away message"): type one or pick one
 * of your recent messages or the presets, see what friends will see, and go.
 * It opens inside the list window, under the Away button.
 */
export function AwayEditor({
  me,
  anchor,
  choices,
  onCancel,
  onGoAway,
}: {
  me: User;
  anchor: { top: number; bottom: number };
  choices: string[];
  onCancel: () => void;
  /** Answers with a problem in words, or null when you're away. */
  onGoAway: (message: string) => Promise<string | null>;
}) {
  const [message, setMessage] = useState(choices[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: 8, y: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card) return;
    const { width } = card.getBoundingClientRect();
    const x = Math.max(8, Math.round((window.innerWidth - width) / 2));
    setAt((held) => (held.x === x ? held : { x, y: held.y }));
  }, []);

  const go = async () => {
    const text = message.trim();
    if (text === "" || busy) return;
    setBusy(true);
    setProblem(null);
    const refused = await onGoAway(text);
    setBusy(false);
    if (refused) setProblem(refused);
  };

  return (
    <Popover label="Away message" at={at} onClose={onCancel}>
      <div className="nx-away" ref={box}>
        <h2 className="nx-away-title">What should friends see?</h2>
        <TextField label="Away message" hideLabel value={message} onChange={setMessage} italic autoFocus maxLength={240} onEnter={() => void go()} error={problem ?? undefined} />
        <ul className="nx-away-choices" aria-label="Recent and suggested away messages">
          {choices.map((choice) => (
            <li key={choice}>
              <button type="button" className="nx-away-choice" aria-pressed={choice === message.trim()} onClick={() => setMessage(choice)}>
                {choice}
              </button>
            </li>
          ))}
        </ul>
        <p className="nx-away-preview">
          <span className="nx-away-preview-label">Friends see</span>
          <Marker {...markerFor(me, "away")} size="sm" />
          <span className="nx-away-preview-name">
            <Name person={me} size="control" />
          </span>
          <span className="nx-away-preview-text">{message.trim() ? `“${message.trim()}”` : "…"}</span>
        </p>
        <div className="nx-away-actions">
          <Button size="md" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="md" variant="primary" icon="moon" busy={busy} disabled={message.trim() === ""} onClick={() => void go()}>
            I'm away
          </Button>
        </div>
      </div>
    </Popover>
  );
}
