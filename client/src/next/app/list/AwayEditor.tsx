import { useLayoutEffect, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { Button, Checkbox, Marker, Name, Popover, TextField } from "../../kit";
import { markerFor } from "../markers";
import "./AwayEditor.css";
import { serverColor } from "./ServerSection";

/** A server the away message can show on, and who you are there. */
export interface AwayServer {
  id: string;
  name: string;
  /** Its color: a palette key, never a value. */
  accent: string | null;
  /** You, there. */
  as: User;
}

/**
 * The away message (SPEC §4.6, "the AIM away message"): type one or pick one
 * of your recent messages or the presets, see what friends will see, and go.
 * It opens inside the list window, under the Away button.
 *
 * With several servers it asks where to show it, each server ticked to start
 * with (docs/design/buddy-list.md, "Away goes everywhere, with a choice"). A
 * server that refuses says why under its own name, and the rest still count.
 */
export function AwayEditor({
  me,
  anchor,
  choices,
  onCancel,
  onGoAway,
  servers,
  onGoAwayOn,
}: {
  me: User;
  anchor: { top: number; bottom: number };
  choices: string[];
  onCancel: () => void;
  /** One server: answers with a problem in words, or null when you're away. */
  onGoAway?: (message: string) => Promise<string | null>;
  /** Several servers: the ones to choose from, in your order. */
  servers?: AwayServer[];
  /** Several servers: go away on these; answers per server with a problem in words, or null where it worked. */
  onGoAwayOn?: (message: string, servers: string[]) => Promise<Record<string, string | null>>;
}) {
  const [message, setMessage] = useState(choices[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(servers?.map((server) => server.id) ?? []));
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const several = servers !== undefined && onGoAwayOn !== undefined;
  // Friends see you as whoever you are on the first server it shows on.
  const shownAs = servers?.find((server) => chosen.has(server.id))?.as ?? me;
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
    if (servers && onGoAwayOn) {
      if (chosen.size === 0) return;
      setBusy(true);
      setProblems({});
      const answers = await onGoAwayOn(text, servers.map((server) => server.id).filter((id) => chosen.has(id)));
      setBusy(false);
      const refused: Record<string, string> = {};
      for (const [id, answer] of Object.entries(answers)) if (answer !== null) refused[id] = answer;
      setProblems(refused);
      return;
    }
    if (!onGoAway) return;
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
        {several && servers ? (
          <fieldset className="nx-away-servers">
            <legend className="nx-away-legend">Show on</legend>
            {servers.map((server) => (
              <div key={server.id} className="nx-away-server" style={serverColor(server.accent)}>
                <Checkbox
                  checked={chosen.has(server.id)}
                  onChange={(on) =>
                    setChosen((held) => {
                      const next = new Set(held);
                      if (on) next.add(server.id);
                      else next.delete(server.id);
                      return next;
                    })
                  }
                >
                  <span className="nx-away-server-mark" aria-hidden="true" />
                  <span className="nx-away-server-name">{server.name}</span>
                  <span className="nx-away-server-as">
                    as <Name person={server.as} size="inline" />
                  </span>
                </Checkbox>
                {problems[server.id] ? (
                  <p className="nx-away-server-problem" role="alert">
                    {problems[server.id]}
                  </p>
                ) : null}
              </div>
            ))}
          </fieldset>
        ) : null}
        <p className="nx-away-preview">
          <span className="nx-away-preview-label">Friends see</span>
          <Marker {...markerFor(shownAs, "away")} size="sm" />
          <span className="nx-away-preview-name">
            <Name person={shownAs} size="control" />
          </span>
          <span className="nx-away-preview-text">{message.trim() ? `“${message.trim()}”` : "…"}</span>
        </p>
        <div className="nx-away-actions">
          <Button size="md" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="md" variant="primary" icon="moon" busy={busy} disabled={message.trim() === "" || (several && chosen.size === 0)} onClick={() => void go()}>
            I'm away
          </Button>
        </div>
      </div>
    </Popover>
  );
}
