import { useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { awayOn, serverNames } from "../../core/servers";
import { Button, Marker, MARKER_WORDS, Name } from "../../kit";
import { markerFor } from "../markers";
import { AwayEditor } from "./AwayEditor";
import { serverColor, type ServerListing } from "./ServerSection";
import "./YouCard.css";

/** Going away and coming back on several servers, each answering per server. */
export interface AwayEverywhere {
  /** Away messages to offer, your own recent ones first. */
  awayChoices: string[];
  /** Go away on these servers; answers per server with a problem in words, or null where it worked. */
  goAway: (message: string, servers: string[]) => Promise<Record<string, string | null>>;
  /** Come back on these servers; answers the same way. */
  comeBack: (servers: string[]) => Promise<Record<string, string | null>>;
}

/**
 * You, at the top of the list, with several servers (docs/design/buddy-list.md,
 * "A different you on each server"): only what's true everywhere, which is
 * you, and whether you're away. Your name and status on each server live in
 * that server's section. Away asks which servers to show it on.
 */
export function YouEverywhere({ me, servers, actions }: { me: User; servers: ServerListing[]; actions?: AwayEverywhere }) {
  const away = awayOn(servers);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ top: number; bottom: number } | null>(null);
  const awayButton = useRef<HTMLDivElement | null>(null);
  const nameOf = (id: string) => servers.find((server) => server.id === id)?.name ?? id;
  const awayWords = away.length === servers.length ? "away" : `away on ${serverNames(away.map(nameOf))}`;

  const comeBack = async () => {
    if (!actions || busy) return;
    setBusy(true);
    setProblem(null);
    const answers = await actions.comeBack(away);
    setBusy(false);
    const refused = Object.entries(answers).filter((entry): entry is [string, string] => entry[1] !== null);
    if (refused.length > 0) setProblem(refused.map(([id, why]) => `${nameOf(id)}: ${why}`).join(" "));
  };

  return (
    <section className="nx-you" aria-label="You">
      <div className="nx-you-top">
        <div className="nx-you-who">
          <Name person={me} size="display" />
          <span className="nx-you-where">
            {away.length > 0 ? (
              <>
                <Marker {...markerFor(me, "away")} size="sm" label={MARKER_WORDS.away} />
                <span className="nx-you-text" title={awayWords}>
                  {awayWords}
                </span>
              </>
            ) : (
              <>
                <span className="nx-you-marks" aria-hidden="true">
                  {servers.map((server) => (
                    <i key={server.id} style={serverColor(server.accent)} />
                  ))}
                </span>
                <span className="nx-you-text">around</span>
              </>
            )}
          </span>
        </div>
        {actions ? (
          <div ref={awayButton}>
            {away.length > 0 ? (
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
                  setEditor({ top: box.top, bottom: box.bottom });
                }}
              >
                Away
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {problem ? (
        <p className="nx-you-problem" role="alert">
          {problem}
        </p>
      ) : null}

      {editor && actions ? (
        <AwayEditor
          me={me}
          anchor={editor}
          choices={actions.awayChoices}
          servers={servers.flatMap((server) =>
            server.model.me ? [{ id: server.id, name: server.name, accent: server.accent, as: server.model.me.user }] : [],
          )}
          onCancel={() => {
            setEditor(null);
            requestAnimationFrame(() => awayButton.current?.querySelector("button")?.focus());
          }}
          onGoAwayOn={async (message, chosen) => {
            const answers = await actions.goAway(message, chosen);
            if (Object.values(answers).every((answer) => answer === null)) setEditor(null);
            return answers;
          }}
        />
      ) : null}
    </section>
  );
}
