import type { CSSProperties, ReactNode } from "react";
import { Fragment, memo, useLayoutEffect, useRef, useState } from "react";
import type { PresenceState } from "../../../generated/PresenceState";
import type { User } from "../../../generated/User";
import { sentencesOf } from "../../core/knock";
import { Button, GroupMarker, HashMark, Marker, MarkerCluster, markerOf } from "../../kit";
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
    };

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
          <p className="nx-pane-sub">{props.topic}</p>
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
  const single = props.people.length === 1 && only ? only : null;
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
        <p className="nx-pane-sub">{status}</p>
      ) : (
        <span className="nx-pane-fill" />
      )}
      {knock ? (
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
      ) : null}
    </Box>
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
