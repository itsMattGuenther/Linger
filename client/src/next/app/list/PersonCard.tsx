import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PresenceState } from "../../../generated/PresenceState";
import type { User } from "../../../generated/User";
import { paletteKey } from "../../../lib/names";
import { Button, Marker, MARKER_WORDS, markerStateOf, Name, Popover } from "../../kit";
import { markerFor } from "../markers";
import "./PersonCard.css";

/** How a knock went, for the button's words (SPEC §4.9). */
export type KnockResult = { ok: true } | { ok: false; problem: string };

export interface PersonCardProps {
  user: User;
  state: PresenceState;
  /** Where they are, said plainly: "in #general", "last here 2d". */
  note: string;
  /** The row that opened it, in window coordinates: the card sits just under it, or just over it if there's no room below. */
  anchor: { top: number; bottom: number };
  onMessage: () => void;
  onKnock: () => Promise<KnockResult>;
  onClose: () => void;
}

/**
 * A person's card, opened from their row (docs/design/buddy-list.md, "The
 * buddy list"): their status in full, where they are, and the two things you
 * can do, Message and Knock. It opens inside the list window, under the row,
 * because the list is its own narrow window and a card beside it would be cut
 * off at the window's edge.
 */
/** Space kept between the card, its row and the window's edges. */
const GAP = 4;
const EDGE = 8;

export function PersonCard({ user, state, note, anchor, onMessage, onKnock, onClose }: PersonCardProps) {
  const first = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });

  // Under the row if the card fits there, over it if not, never off the
  // window: measured once it is drawn, before it is painted.
  useLayoutEffect(() => {
    const card = first.current?.parentElement;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x = Math.max(EDGE, Math.round((window.innerWidth - width) / 2));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom]);
  const [phase, setPhase] = useState<"idle" | "knocking" | "knocked">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  // Focus goes into the card when it opens (the row gets it back on close).
  useEffect(() => {
    first.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, []);

  // "Knocked" for three seconds, then the button is ready again (SPEC §4.9):
  // an acknowledgement of the request, not a record of it.
  useEffect(() => {
    if (phase !== "knocked") return;
    const timer = window.setTimeout(() => setPhase("idle"), 3_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const knock = async () => {
    if (phase !== "idle") return;
    setPhase("knocking");
    setProblem(null);
    const result = await onKnock();
    if (result.ok) setPhase("knocked");
    else {
      setPhase("idle");
      setProblem(result.problem);
    }
  };

  const status = user.status;
  const away = state === "away";
  const words = away ? (status?.away_message ?? null) : (status?.line ?? null);
  const fields: [string, string | null | undefined][] = [
    ["Listening to", status?.listening],
    ["Reading", status?.reading],
    ["Working on", status?.working_on],
  ];

  return (
    <Popover label={user.display_name} tint={paletteKey(user) ?? undefined} at={at} onClose={onClose}>
      <div className="nx-person" ref={first}>
        <div className="nx-person-head">
          <Name person={user} size="display" />
          <span className="nx-person-where">
            <Marker {...markerFor(user, state)} size="sm" label={MARKER_WORDS[markerStateOf(state)]} />
            <span className="nx-person-note">{note}</span>
          </span>
        </div>
        {words ? (
          <p className="nx-person-status" data-away={away ? "yes" : undefined}>
            {words}
          </p>
        ) : null}
        {fields.some(([, value]) => value) ? (
          <dl className="nx-person-fields">
            {fields.map(([label, value]) =>
              value ? (
                <div key={label} className="nx-person-field">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : null}
        <div className="nx-person-actions">
          <Button variant="primary" size="md" icon="message" onClick={onMessage}>
            Message
          </Button>
          <Button
            variant="secondary"
            size="md"
            icon="knock"
            busy={phase === "knocking"}
            disabled={state === "offline" || phase !== "idle"}
            onClick={() => void knock()}
          >
            {phase === "knocked" ? "Knocked" : "Knock"}
          </Button>
        </div>
        {problem ? (
          <p className="nx-person-problem" role="status">
            {problem}
          </p>
        ) : null}
      </div>
    </Popover>
  );
}
