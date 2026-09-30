import { Fragment, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PresenceState } from "../../../generated/PresenceState";
import type { User } from "../../../generated/User";
import { openExternal } from "../../../lib/external";
import { paletteKey } from "../../../lib/names";
import { fieldsOf } from "../../../lib/status";
import { valueParts } from "../../../lib/statusLinks";
import { Button, Marker, MARKER_WORDS, markerStateOf, Name, Popover } from "../../kit";
import { knockOfflineLine, sentencesOf, type KnockResult } from "../../core/knock";
import { markerFor } from "../markers";
import "./PersonCard.css";
import { centredOnList } from "./listSpan";


interface CardBase {
  user: User;
  state: PresenceState;
  /** Where they are, said plainly: "in #general", "last here 2d". */
  note: string;
  /**
   * What opened it, in window coordinates: the card sits just under it, or
   * just over it if there's no room below. Centred across the window (the
   * narrow list), or from `left` when given (a name in a wide conversation).
   */
  anchor: { top: number; bottom: number; left?: number };
  onClose: () => void;
}

/** Somebody else's card: Message and Knock. */
interface TheirCard {
  onMessage: () => void;
  onKnock: () => Promise<KnockResult>;
  /** Why a knock from their row didn't go, when that's what opened the card. */
  problem?: string | null;
  onEditProfile?: undefined;
}

/**
 * Your own card (#271): the same card friends see, saying so, with Edit
 * profile (Settings → Profile) where Message and Knock would be.
 */
interface YourCard {
  onEditProfile: () => void;
  onMessage?: undefined;
  onKnock?: undefined;
  problem?: undefined;
}

export type PersonCardProps = CardBase & (TheirCard | YourCard);

/**
 * A person's card, opened from their row (docs/design/buddy-list.md, "The
 * buddy list"): their status in full, where they are, and the two things you
 * can do, Message and Knock. It opens inside the list window, under the row,
 * because the list is its own narrow window and a card beside it would be cut
 * off at the window's edge. A name in a conversation opens the same card
 * (PPL-6).
 *
 * Your own name opens this card too, not a look-alike, so the preview can't
 * drift from what friends see (#271): the same presence, note, status and
 * fields, under a quiet line saying whose view it is, and Edit profile in
 * place of Message and Knock.
 */
/** Space kept between the card, its row and the window's edges. */
const GAP = 4;
const EDGE = 8;

export function PersonCard({ user, state, note, anchor, onMessage, onKnock, onEditProfile, onClose, problem: refused = null }: PersonCardProps) {
  const first = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });

  // Under the row if the card fits there, over it if not, never off the
  // window: measured once it is drawn, before it is painted.
  useLayoutEffect(() => {
    const card = first.current?.parentElement;
    if (!card) return;
    // Layout sizes, not the drawn box: the card is still scaled down by its opening animation here.
    const { offsetWidth: width, offsetHeight: height } = card;
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x =
      anchor.left === undefined
        ? centredOnList(width, EDGE)
        : Math.max(EDGE, Math.min(Math.round(anchor.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom, anchor.left]);
  const [phase, setPhase] = useState<"idle" | "knocking" | "knocked">("idle");
  const [problem, setProblem] = useState<string | null>(refused);

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
    if (phase !== "idle" || !onKnock) return;
    setPhase("knocking");
    setProblem(null);
    const result = await onKnock();
    if (result.ok) setPhase("knocked");
    else {
      setPhase("idle");
      setProblem(result.problem);
    }
  };

  // Somebody offline can't be knocked (#288): the button stays, greyed out,
  // and the reason shows where a refused knock's does, for as long as
  // they're offline. It's worked out from their presence on every draw, so
  // the card comes back to normal the moment they're online again.
  const offline = onKnock && state === "offline" ? knockOfflineLine(user.display_name) : null;
  const shown = offline ?? problem;

  const status = user.status;
  const away = state === "away";
  const words = away ? (status?.away_message ?? null) : (status?.line ?? null);
  const fields = fieldsOf(status);

  return (
    <Popover label={user.display_name} tint={paletteKey(user) ?? undefined} at={at} onClose={onClose}>
      <div className="nx-person" ref={first}>
        {onEditProfile ? <p className="nx-person-yours">This is how friends see you</p> : null}
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
        {fields.length > 0 ? (
          <dl className="nx-person-fields">
            {fields.map((field) => (
              <div key={field.label} className="nx-person-field">
                <dt>{field.label}</dt>
                <dd>
                  <FieldValue value={field.value} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="nx-person-actions">
          {onEditProfile ? (
            <Button variant="primary" size="md" icon="pencil" onClick={onEditProfile}>
              Edit profile
            </Button>
          ) : (
            <>
              <Button variant="primary" size="md" icon="message" onClick={onMessage}>
                Message
              </Button>
              <Button
                variant="secondary"
                size="md"
                icon="knock"
                busy={phase === "knocking"}
                disabled={phase !== "idle"}
                unavailable={offline ?? undefined}
                onClick={() => void knock()}
              >
                {phase === "knocked" ? "Knocked" : "Knock"}
              </Button>
            </>
          )}
        </div>
        {shown ? (
          <p className="nx-person-problem" data-tone={offline ? "quiet" : undefined} role="status">
            {sentencesOf(shown).map((sentence, at) => (
              <Fragment key={at}>
                {at > 0 ? " " : null}
                <span className="nx-person-sentence">{sentence}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
    </Popover>
  );
}

/**
 * What a field says, with its web addresses drawn as links (#270): each opens
 * in the browser, never in this window, the way a link in a message does
 * (`lib/external.ts`). Nothing else in it is a link (`lib/statusLinks.ts`).
 */
function FieldValue({ value }: { value: string }) {
  return (
    <>
      {valueParts(value).map((part, at) =>
        part.kind === "link" ? (
          <a
            key={at}
            className="nx-person-link"
            href={part.href}
            title={part.href}
            rel="noreferrer noopener"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              openExternal(part.href);
            }}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={at}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
