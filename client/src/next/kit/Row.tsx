import type { MouseEvent, ReactNode } from "react";
import { GroupMarker, HashMark, Marker, MarkerSlot, type MarkerPerson } from "./Marker";
import "./Row.css";

/** What sits in a row's lead column. */
export type RowLead =
  | { kind: "person"; person: MarkerPerson; typing?: boolean }
  | { kind: "group"; people: MarkerPerson[] }
  | { kind: "room" }
  | { kind: "none" };

export interface RowProps {
  lead: RowLead;
  /** One line (32px) or two (48px). Fixed either way. */
  lines: "one" | "two";
  /** The first line: usually a `Name`, or a room's name. */
  title: ReactNode;
  /** The second line of a two-line row: a status, an away message. */
  detail?: ReactNode;
  /** Draw the second line in the warm away color. */
  away?: boolean;
  /** A short faint note at the end of the first line: "in #general". */
  note?: string;
  /** Small marks right after the title, like a voice glyph beside a name. */
  trailing?: ReactNode;
  /** Small marks at the end of the first line, like who's in a room. */
  end?: ReactNode;
  /**
   * Up to three `IconButton`s (size sm or md) shown on hover and keyboard
   * focus. The row's text makes room for them; they never cover it.
   */
  actions?: ReactNode[];
  /** Something new here: the title goes bold. Weight only, never a count. */
  fresh?: boolean;
  /** This row's card or window is open. */
  selected?: boolean;
  /** A knock just went to this person: the row gives one small shake (none for reduced motion). */
  knocked?: boolean;
  /** The accessible name, when the visible text isn't enough on its own. */
  label?: string;
  /** Shown but not usable for now, like people once a picker is full. */
  disabled?: boolean;
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
  onDoubleActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
}

function Lead({ lead }: { lead: RowLead }) {
  switch (lead.kind) {
    case "person":
      return (
        <MarkerSlot>
          <Marker color={lead.person.color} state={lead.person.state} typing={lead.typing} />
        </MarkerSlot>
      );
    case "group":
      return (
        <MarkerSlot>
          <GroupMarker people={lead.people} />
        </MarkerSlot>
      );
    case "room":
      return (
        <MarkerSlot>
          <HashMark />
        </MarkerSlot>
      );
    case "none":
      return <MarkerSlot />;
  }
}

/**
 * The list row: rooms, DMs, people, pickers. Every row has the same anatomy —
 * a fixed lead column, a fixed-height name line, an optional fixed-height
 * second line — so names line up and gaps are even by construction.
 */
export function Row({
  lead,
  lines,
  title,
  detail,
  away = false,
  note,
  trailing,
  end,
  actions,
  fresh = false,
  selected = false,
  knocked = false,
  label,
  disabled = false,
  onActivate,
  onDoubleActivate,
}: RowProps) {
  const count = Math.min(actions?.length ?? 0, 3);
  return (
    <li
      className="k-row"
      data-kit="Row"
      data-row-kind={lines}
      data-actions={count || undefined}
      data-fresh={fresh ? "yes" : undefined}
      data-selected={selected ? "yes" : undefined}
      data-knocked={knocked ? "yes" : undefined}
    >
      <button
        type="button"
        className="k-row-main"
        aria-label={label}
        aria-current={selected || undefined}
        disabled={disabled}
        onClick={onActivate}
        onDoubleClick={onDoubleActivate}
      >
        <Lead lead={lead} />
        <span className="k-row-text" data-kit-row-text="">
          <span className="k-row-top">
            <span className="k-row-title">{title}</span>
            {trailing ? <span className="k-row-trailing">{trailing}</span> : null}
            {note ? <span className="k-row-note">{note}</span> : null}
            {end ? <span className="k-row-end">{end}</span> : null}
          </span>
          {/* No second line to show: the row keeps its height and the name sits level with the marker. */}
          {lines === "two" && detail ? (
            <span className="k-row-detail" data-away={away ? "yes" : undefined}>
              {detail}
            </span>
          ) : null}
        </span>
      </button>
      {count > 0 ? <span className="k-row-actions">{actions?.slice(0, 3)}</span> : null}
    </li>
  );
}

/** A list of rows, with a name for assistive technology. */
export function RowList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="k-rows" data-kit="RowList" data-kit-list="" aria-label={label}>
      {children}
    </ul>
  );
}
