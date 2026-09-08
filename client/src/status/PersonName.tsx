/**
 * A name in the stream, and the card you get when you click it (SPEC §4.6).
 *
 * The roster is where you go to look at everybody. The popover is for the other
 * direction: you are reading, a name goes past, and you want to know who that
 * is without leaving the message you are on.
 *
 * It renders through a portal, into the body rather than into the message.
 * The stream is virtualized — every row sits in a scrolling box under a
 * transform — so a card drawn inside a row would be clipped by the first edge
 * it reached. Fixed position off the name's own rectangle is the one placement
 * that survives that.
 */
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PresenceState } from "../generated/PresenceState";
import type { User } from "../generated/User";
import { nameProps, personStyle } from "../lib/names";
import { stateWord } from "../roster/roster";
import StatusCard from "./StatusCard";
import { awayMessageOf, isBlank } from "./status";
import "./status.css";

/** Breathing room between the name and the card, and from the window edge. */
const GAP_PX = 4;
const EDGE_PX = 8;

export default function PersonName({
  baseUrl,
  user,
  name,
  state,
  className,
}: {
  baseUrl: string;
  /** Undefined for somebody the store has never heard of. */
  user: User | undefined;
  /** What to draw. The caller already worked out the fallback. */
  name: string;
  /** Their presence right now, for the line under the name in the card. */
  state: PresenceState;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  // Stable, so the popover's listeners are attached once rather than torn down
  // and rebuilt every time the stream re-renders the row underneath it.
  const close = useCallback(() => setOpen(false), []);

  // Nobody to show. A button that opens an empty card is worse than plain text.
  if (!user) {
    return <span {...nameProps(user, className)}>{name}</span>;
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        {...nameProps(user, `${className} person-link`)}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((held) => !held)}
      >
        {name}
      </button>
      {open ? (
        <Popover user={user} state={state} anchor={anchor.current} onClose={close} baseUrl={baseUrl} />
      ) : null}
    </>
  );
}

function Popover({
  baseUrl,
  user,
  state,
  anchor,
  onClose,
}: {
  baseUrl: string;
  user: User;
  state: PresenceState;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<CSSProperties>({
    // Off-screen until measured, so nothing is seen in the wrong place first.
    visibility: "hidden",
    top: 0,
    left: 0,
  });

  // Measure, then place. Flip above the name when there is no room below, and
  // pull back from whichever edge it would otherwise cross.
  useLayoutEffect(() => {
    if (!anchor || !card.current) return;
    const from = anchor.getBoundingClientRect();
    const size = card.current.getBoundingClientRect();
    const roomBelow = window.innerHeight - from.bottom;
    const above = roomBelow < size.height + GAP_PX + EDGE_PX && from.top > roomBelow;
    const top = above ? from.top - size.height - GAP_PX : from.bottom + GAP_PX;
    const left = Math.min(from.left, window.innerWidth - size.width - EDGE_PX);
    setPlacement({
      visibility: "visible",
      top: Math.max(EDGE_PX, Math.min(top, window.innerHeight - size.height - EDGE_PX)),
      left: Math.max(EDGE_PX, left),
    });
  }, [anchor]);

  // Escape, a click elsewhere, or the stream moving under it. The last one
  // matters most: this is fixed to the viewport and the name is not, so a
  // scroll would leave the card pointing at nothing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && card.current?.contains(target)) return;
      if (target instanceof Node && anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture, so a scroller that stops propagation cannot strand the card.
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  const away = awayMessageOf(user);
  const empty = isBlank(user.status);

  return createPortal(
    <div
      ref={card}
      className="person-popover"
      role="dialog"
      aria-label={`${user.display_name}, ${stateWord(state)}`}
      style={{ ...placement, ...personStyle(user) }}
    >
      <p className="popover-head">
        <span className="person-dot" data-state={state} aria-hidden="true" />
        <span {...nameProps(user, "person-name")}>{user.display_name}</span>
        <span className="popover-username meta">@{user.username}</span>
      </p>
      <p className="popover-state meta">{stateWord(state)}</p>
      {/* The away message supersedes the status line (SPEC §4.6), so it is
          drawn here and `StatusCard` is told to leave the line out. */}
      {away === null ? null : <p className="person-away">“{away}”</p>}
      <StatusCard user={user} awayShown={away !== null} baseUrl={baseUrl} />
      {empty ? <p className="popover-empty meta">no status</p> : null}
    </div>,
    document.body,
  );
}
