import type { CSSProperties } from "react";
import { memo } from "react";
import type { PresenceState } from "../../../generated/PresenceState";
import type { User } from "../../../generated/User";
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
      /** A one-to-one DM offers a knock. `knocked` for the three seconds after. */
      onKnock?: () => void;
      knocked?: boolean;
    };

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
 * of a conversation's own window, where the title bar is the header and the
 * window is dragged by it.
 */
export const PaneHeader = memo(function PaneHeader({ place = "row", ...props }: PaneHeaderProps & { place?: "row" | "title" }) {
  const tag = props.server ? <ServerChip server={props.server} /> : null;
  const Box = place === "title" ? "div" : "header";
  const drag = place === "title" ? { "data-tauri-drag-region": "" } : {};
  if (props.kind === "room") {
    return (
      <Box className="nx-pane-head" data-kind="room" data-place={place} {...drag}>
        <span className="nx-pane-name" {...drag}>
          <HashMark />
          <h2 className="nx-pane-title" {...drag}>
            {props.name}
          </h2>
        </span>
        {props.people.length > 0 ? <MarkerCluster people={props.people.map((user) => markerOf(user, "in_room"))} /> : null}
        {tag}
        {props.topic ? (
          <p className="nx-pane-sub" {...drag}>
            {props.topic}
          </p>
        ) : (
          <span className="nx-pane-fill" {...drag} />
        )}
      </Box>
    );
  }
  const [only] = props.people;
  const single = props.people.length === 1 && only ? only : null;
  const status = single ? (single.user.status?.away_message ?? single.user.status?.line ?? null) : null;
  return (
    <Box className="nx-pane-head" data-kind="dm" data-place={place} {...drag}>
      {single ? (
        <Marker {...markerOf(single.user, single.state)} />
      ) : (
        <GroupMarker people={props.people.map(({ user, state }) => markerOf(user, state))} />
      )}
      <h2 className="nx-pane-title" {...drag}>
        {props.label}
      </h2>
      {tag}
      {status ? (
        <p className="nx-pane-sub" {...drag}>
          {status}
        </p>
      ) : (
        <span className="nx-pane-fill" {...drag} />
      )}
      {props.onKnock ? (
        <Button size="sm" variant="secondary" icon="knock" disabled={props.knocked} onClick={props.onKnock}>
          {props.knocked ? "Knocked" : "Knock"}
        </Button>
      ) : null}
    </Box>
  );
});

function ServerChip({ server }: { server: ServerTag }) {
  const key = /^[a-z]{2,16}$/.test(server.color) ? server.color : "slate";
  return (
    <span className="nx-pane-server" style={{ "--server": `var(--name-${key})` } as CSSProperties}>
      <i aria-hidden="true" />
      <span>{server.name}</span>
    </span>
  );
}
