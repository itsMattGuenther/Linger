import type { CSSProperties, ReactNode } from "react";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PresenceState } from "../../../generated/PresenceState";
import type { User } from "../../../generated/User";
import { sentencesOf } from "../../core/knock";
import { onPhone } from "../../core/phone";
import { Button, GroupMarker, HashMark, Marker, MARKER_WORDS, MarkerCluster, markerOf, markerStateOf, Name, Popover } from "../../kit";
import { LeaveGroup } from "../LeaveGroup";
import { PersonFields } from "../PersonFields";
import "./PaneHeader.css";

export type PaneHeaderProps =
  | {
      kind: "room";
      name: string;
      topic: string | null;
      /** Who is in the room. */
      people: readonly User[];
      server?: ServerTag;
    }
  | {
      kind: "dm";
      /** Named by who else is in it (SPEC §4.13). */
      label: string;
      people: readonly { user: User; state: PresenceState }[];
      server?: ServerTag;
      /** A one-to-one DM offers a knock. */
      knock?: HeaderKnock;
      /**
       * A one-to-one DM beside the list is its person (#351): their card is
       * the header. Where they are, as their row in the list says it.
       */
      person?: { note: string };
      /**
       * A group, however few are left in it (#565): drawn as a group, never
       * as its one other person.
       */
      group?: boolean;
      /** A group's ⋯ menu, with Leave (#565). Never on a one-to-one DM. */
      leave?: HeaderLeave;
    };

/** Leaving a group from its header (#565). */
export interface HeaderLeave {
  /** Nobody else is in it any more, so leaving deletes it. */
  last: boolean;
  /** Resolves to null once it's done, or the problem in words. */
  onLeave: () => Promise<string | null>;
}

/**
 * The Knock in a one-to-one DM's header, with everything it can say
 * (SPEC §4.9, #288).
 */
export interface HeaderKnock {
  onKnock: () => void;
  /** Waiting for the server, then "Knocked" for three seconds after one went. */
  phase: "idle" | "knocking" | "knocked";
  /** Why it can't be pressed: "Can't knock while Jules is offline." */
  unavailable?: string;
  /** Why the last one didn't go, for a few seconds: `knockOn`'s sentence. */
  problem?: string | null;
}

/** With several servers, which one this conversation is on. */
export interface ServerTag {
  name: string;
  /** Palette key, never a color value. */
  color: string;
}

/**
 * The line under the tabs: what this conversation is. A room is its name,
 * who's in it and its topic, and never a list of names (#145). A DM is who's
 * in it; a one-to-one DM adds their status and a knock.
 */
/**
 * `place`: its own row under the tabs (the default), or inside the title bar
 * of a conversation's own window, where the title bar is the header. The
 * window is dragged by any of it but the Knock button: the title bar is the
 * drag region, everything inside included (TitleBar.tsx).
 */
export const PaneHeader = memo(function PaneHeader({ place = "row", ...props }: PaneHeaderProps & { place?: "row" | "title" }) {
  const tag = props.server ? <ServerChip server={props.server} /> : null;
  const Box = place === "title" ? "div" : "header";
  if (props.kind === "room") {
    return (
      <Box className="nx-pane-head" data-kind="room" data-place={place}>
        <span className="nx-pane-name">
          <HashMark />
          <h2 className="nx-pane-title">{props.name}</h2>
        </span>
        {props.people.length > 0 ? <MarkerCluster people={props.people.map((user) => markerOf(user, "in_room"))} /> : null}
        {tag}
        {props.topic ? (
          <WholeLine text={props.topic} label={`The topic of #${props.name}`} />
        ) : (
          <span className="nx-pane-fill" />
        )}
      </Box>
    );
  }
  return <DmHeader {...props} Box={Box} place={place} tag={tag} />;
});

type DmHeaderProps = Extract<PaneHeaderProps, { kind: "dm" }> & { Box: "div" | "header"; place: "row" | "title"; tag: ReactNode };

/** A DM's header: who's in it, and for one person, their status and Knock. */
function DmHeader({ Box, place, tag, ...props }: DmHeaderProps) {
  const [only] = props.people;
  const single = props.people.length === 1 && only && props.group !== true ? only : null;
  const status = single ? (single.user.status?.away_message ?? single.user.status?.line ?? null) : null;
  const knock = props.knock;
  const problem = knock?.problem ?? null;
  // A refused knock's reason goes where their status sits when it fits there
  // on one line. A header too narrow for that (the chat window at its
  // narrowest, a conversation's own window) says it in the Knock button's
  // bubble instead. Measured before it's painted, so it never shows cut.
  const said = useRef<HTMLParagraphElement | null>(null);
  const [cramped, setCramped] = useState<string | null>(null);
  const inline = problem !== null && cramped !== problem;
  useLayoutEffect(() => {
    if (problem === null) {
      setCramped(null);
      return;
    }
    const node = said.current;
    if (!inline || !node) return;
    if (node.scrollWidth > node.clientWidth + 1) setCramped(problem);
  }, [problem, inline]);
  const sentences = problem
    ? sentencesOf(problem).map((sentence, at) => (
        <Fragment key={at}>
          {at > 0 ? " " : null}
          <span className="nx-pane-sentence">{sentence}</span>
        </Fragment>
      ))
    : null;
  const knockButton = knock ? (
    <Button
      size="sm"
      variant="secondary"
      icon="knock"
      busy={knock.phase === "knocking"}
      disabled={knock.phase !== "idle"}
      unavailable={knock.unavailable}
      note={problem !== null && !inline ? sentences : undefined}
      onClick={knock.onKnock}
    >
      {knock.phase === "knocked" ? "Knocked" : "Knock"}
    </Button>
  ) : null;
  // Beside the list, a one-to-one DM is its person (#351): their card on
  // top, the conversation under it. Their status is whole here, wrapping,
  // and so is a refused knock's reason in its place.
  if (single && props.person && place === "row") {
    const away = single.state === "away";
    return (
      <Box className="nx-pane-head" data-kind="dm" data-place={place} data-person="yes">
        <div className="nx-pane-person-top">
          <h2 className="nx-pane-title">
            <Name person={single.user} size="display" dim={single.state === "idle" || away || single.state === "offline"} />
          </h2>
          {tag}
          <span className="nx-pane-fill" />
          {knockButton}
        </div>
        <span className="nx-pane-where">
          <Marker {...markerOf(single.user, single.state)} size="sm" label={MARKER_WORDS[markerStateOf(single.state)]} />
          <span className="nx-pane-note">{props.person.note}</span>
        </span>
        {inline ? (
          <p ref={said} className="nx-pane-sub" data-problem="yes" role="status">
            {sentences}
          </p>
        ) : status ? (
          <p className="nx-pane-sub" data-away={away ? "yes" : undefined}>
            {status}
          </p>
        ) : null}
        <PersonFields status={single.user.status} />
      </Box>
    );
  }
  return (
    <Box className="nx-pane-head" data-kind="dm" data-place={place}>
      {single ? (
        <Marker {...markerOf(single.user, single.state)} />
      ) : (
        <GroupMarker people={props.people.map(({ user, state }) => markerOf(user, state))} />
      )}
      <h2 className="nx-pane-title">{props.label}</h2>
      {tag}
      {inline ? (
        // A refused knock says why where their status sits, for a few
        // seconds, then the status comes back (#288).
        <p ref={said} className="nx-pane-sub" data-problem="yes" role="status">
          {sentences}
        </p>
      ) : status ? (
        <WholeLine text={status} label={`${props.label}'s status`} />
      ) : (
        <span className="nx-pane-fill" />
      )}
      {knockButton}
      {props.leave ? <LeaveGroup label={props.label} last={props.leave.last} onLeave={props.leave.onLeave} /> : null}
    </Box>
  );
}

/**
 * A room's topic or a friend's status in the header (#778), on one line and
 * cut with "…" when it's longer than the header. Cut, it's a button, marked
 * the way the app marks words that open more ("and others", why voice didn't
 * start): a click or a tap opens the whole of it in a card, a sheet on the
 * phone. Not cut, it's only words. Screen readers have the whole of it
 * either way. Measured before it's painted, and again whenever the header's
 * width changes, so it's never a button with nothing more to show.
 */
function WholeLine({ text, label }: { text: string; label: string }) {
  // Whichever element does the cutting: the line, or its button once cut.
  const [line, setLine] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState<DOMRect | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!line) return;
    const measure = () => setCut(line.scrollWidth > line.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(line);
    return () => watch.disconnect();
  }, [line, text]);
  // No longer cut (the window grew): nothing to keep open.
  useEffect(() => {
    if (!cut) setOpen(null);
  }, [cut]);
  return (
    <p ref={cut ? undefined : setLine} className="nx-pane-sub" data-cut={cut ? "yes" : undefined}>
      {cut ? (
        <button
          ref={(node) => {
            opener.current = node;
            setLine(node);
          }}
          type="button"
          className="nx-pane-whole"
          aria-haspopup="dialog"
          aria-expanded={open !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setOpen((held) => (held ? null : rect));
          }}
        >
          {text}
        </button>
      ) : (
        text
      )}
      {open ? (
        <WholeCard
          anchor={open}
          label={label}
          text={text}
          onClose={() => {
            setOpen(null);
            opener.current?.focus();
          }}
        />
      ) : null}
    </p>
  );
}

/** Space kept between the card and what opened it, and from the window's edges. */
const GAP = 6;
const EDGE = 8;

/**
 * The whole of a cut topic or status (#778): under the words, or over them if
 * there's no room below, and never off the window; risen from the bottom on
 * the phone (`Sheet`). Escape, Close, or a press anywhere else closes it.
 */
function WholeCard({ anchor, label, text, onClose }: { anchor: DOMRect; label: string; text: string; onClose: () => void }) {
  const sheet = onPhone();
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });
  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card || sheet) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(anchor.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom, anchor.left, sheet]);
  // Close has the focus to start with. On a computer a press anywhere else
  // closes it; on the phone the sheet's dimmed page does, by its tap (#704).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.parentElement?.querySelector<HTMLButtonElement>(".k-popover-close button")?.focus();
    if (sheet) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.parentElement?.contains(event.target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [sheet]);
  return createPortal(
    <Popover label={label} at={sheet ? undefined : at} sheet={sheet} onClose={onClose}>
      <div ref={box} className="nx-pane-whole-card">
        <p className="nx-pane-whole-text">{text}</p>
      </div>
    </Popover>,
    document.body,
  );
}

function ServerChip({ server }: { server: ServerTag }) {
  const key = /^[a-z]{2,16}$/.test(server.color) ? server.color : "slate";
  return (
    <span className="nx-pane-server" style={{ "--server": `var(--name-${key})` } as CSSProperties}>
      <i aria-hidden="true" />
      <span>{server.name}</span>
    </span>
  );
}
