import { type FocusEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { GroupMarker, HashMark, Marker, MarkerSlot, type MarkerPerson } from "./Marker";
import { TooltipBubble } from "./Tooltip";
import "./Row.css";

/** What sits in a row's lead column. */
export type RowLead =
  | { kind: "person"; person: MarkerPerson; typing?: boolean }
  | { kind: "group"; people: MarkerPerson[] }
  | { kind: "room" }
  /** A mark of its own, like the flag on the host's "A report to look at" (T-1605). */
  | { kind: "icon"; icon: IconName }
  /** An emoji, as the `:` list in the message box offers it (#359). */
  | { kind: "emoji"; glyph: string }
  /** A server's own emoji's picture (#359). Decorative: the row's title names it. */
  | { kind: "picture"; url: string }
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
  /**
   * Show the whole second line in a tooltip on hover or keyboard focus, when
   * the row has had to cut it short (#351: a person's whole status, without
   * opening anything). It's in the row's text already for assistive
   * technology, so the tooltip is for eyes only.
   */
  detailTip?: boolean;
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
  /**
   * Something new that's addressed to you, a DM (#291): the row is lit in
   * the lamp, a soft fill and a thin edge, as well as bold. Never a count.
   */
  lit?: boolean;
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
  /**
   * One choice in a listbox (`OptionList`) instead of a button. The keyboard
   * stays in the text box that owns the list, so the row never takes focus:
   * `active` is the choice that box has highlighted, and a click picks it.
   */
  option?: { id: string; active: boolean; onPick: () => void };
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
    case "icon":
      return (
        <MarkerSlot>
          <Icon name={lead.icon} size="sm" />
        </MarkerSlot>
      );
    case "emoji":
      return (
        <MarkerSlot>
          <span className="nx-row-emoji" aria-hidden="true">
            {lead.glyph}
          </span>
        </MarkerSlot>
      );
    case "picture":
      return (
        <MarkerSlot>
          <img className="nx-row-picture" src={lead.url} alt="" draggable={false} />
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
  detailTip = false,
  note,
  trailing,
  end,
  actions,
  fresh = false,
  lit = false,
  selected = false,
  knocked = false,
  label,
  disabled = false,
  onActivate,
  onDoubleActivate,
  option,
}: RowProps) {
  const count = Math.min(actions?.length ?? 0, 3);
  const detailNode = useRef<HTMLSpanElement | null>(null);
  const [tipAt, setTipAt] = useState<HTMLElement | null>(null);
  const cut = () => {
    const node = detailNode.current;
    return node !== null && node.scrollWidth > node.clientWidth + 1;
  };
  const tip =
    detailTip && lines === "two" && detail
      ? {
          onPointerEnter: (event: MouseEvent<HTMLButtonElement>) => {
            if (cut()) setTipAt(event.currentTarget);
          },
          onPointerLeave: () => setTipAt(null),
          onFocus: (event: FocusEvent<HTMLButtonElement>) => {
            if (event.currentTarget.matches(":focus-visible") && cut()) setTipAt(event.currentTarget);
          },
          onBlur: () => setTipAt(null),
        }
      : {};
  const text = (
    <span className="k-row-text" data-kit-row-text="">
      <span className="k-row-top">
        <span className="k-row-title">{title}</span>
        {trailing ? <span className="k-row-trailing">{trailing}</span> : null}
        {note ? <span className="k-row-note">{note}</span> : null}
        {end ? <span className="k-row-end">{end}</span> : null}
      </span>
      {/* No second line to show: the row keeps its height and the name sits level with the marker. */}
      {lines === "two" && detail ? (
        <span className="k-row-detail" data-away={away ? "yes" : undefined} ref={detailNode}>
          {detail}
        </span>
      ) : null}
    </span>
  );
  if (option) {
    return (
      <li
        className="k-row"
        data-kit="Row"
        data-row-kind={lines}
        data-active={option.active ? "yes" : undefined}
        role="option"
        id={option.id}
        aria-selected={option.active}
        aria-label={label}
        onClick={option.onPick}
      >
        <span className="k-row-main">
          <Lead lead={lead} />
          {text}
        </span>
      </li>
    );
  }
  return (
    <li
      className="k-row"
      data-kit="Row"
      data-row-kind={lines}
      data-actions={count || undefined}
      data-fresh={fresh ? "yes" : undefined}
      data-lit={lit ? "yes" : undefined}
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
        {...tip}
      >
        <Lead lead={lead} />
        {text}
      </button>
      {count > 0 ? <span className="k-row-actions">{actions?.slice(0, 3)}</span> : null}
      {tipAt ? <TooltipBubble anchor={tipAt}>{detail}</TooltipBubble> : null}
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
