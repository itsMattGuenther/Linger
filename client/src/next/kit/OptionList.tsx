import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Anchor, placeBeside } from "./place";
import { Row, type RowLead } from "./Row";
import "./OptionList.css";

/** About six rows show before the list scrolls; the half row says there are more. */
const ROWS_SHOWN = 6.5;

/** One choice: drawn as a one-line row, as rows are everywhere. */
export interface OptionItem {
  id: string;
  lead: RowLead;
  /** The row's first line: usually a `Name`. */
  title: ReactNode;
  /** A small label at the end of the line: "@justin". */
  note?: string;
  /** What a screen reader hears when this one is highlighted. */
  label: string;
}

/** The element id of an option, for the text box's `aria-activedescendant`. */
export function optionId(listId: string, itemId: string): string {
  return `${listId}-${itemId}`;
}

/**
 * A short list of choices that floats by a text box which keeps the
 * keyboard, like the people the message box offers after an `@`. The box is
 * the combobox and owns the keys: it says which choice is highlighted
 * (`active`), points at it with `aria-activedescendant`, and moves it.
 *
 * Drawn in a portal like `Menu`, so no scrolling list or window edge can cut
 * it off, and placed by the same rule (`place.ts`): below the box, or above
 * when there's no room below, lined up with its start edge. A press never
 * takes the focus from the box, and the pointer moves the highlight.
 *
 * Only the number of choices changes its height, so typing that narrows the
 * list measures nothing: the row and frame are measured once, when it opens
 * (lessons L-12).
 */
export function OptionList({
  id,
  label,
  items,
  active,
  anchor,
  onActive,
  onPick,
}: {
  /** The listbox's element id, which the box names in `aria-controls`. */
  id: string;
  label: string;
  items: readonly OptionItem[];
  /** The highlighted choice's id: the one Enter would take. */
  active: string | null;
  /** The text box, in the window. */
  anchor: Anchor;
  onActive: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const box = useRef<HTMLUListElement | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const metrics = useRef<{ row: number; frame: number; width: number } | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number; height: number } | null>(null);
  const count = items.length;

  useLayoutEffect(() => {
    const node = box.current;
    if (!node || count === 0) return;
    if (metrics.current === null) {
      const style = getComputedStyle(node);
      const row = node.querySelector<HTMLElement>('[role="option"]')?.offsetHeight ?? 0;
      const frame = node.offsetHeight - node.clientHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      metrics.current = { row, frame, width: node.offsetWidth };
    }
    const { row, frame, width } = metrics.current;
    const height = Math.min(count, ROWS_SHOWN) * row + frame;
    const at = placeBeside(anchor, { width, height }, "start");
    const next = { top: at.top, left: at.left, height: Math.min(height, at.room) };
    setPlace((held) => (held && held.top === next.top && held.left === next.left && held.height === next.height ? held : next));
  }, [anchor.top, anchor.left, anchor.right, anchor.bottom, count]);

  // Keep the highlighted choice in view as the keys move it.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || active === null || place === null) return;
    const item = node.ownerDocument.getElementById(optionId(id, active));
    if (!item || !node.contains(item)) return;
    const pad = Number.parseFloat(getComputedStyle(node).paddingTop);
    if (item.offsetTop - pad < node.scrollTop) node.scrollTop = item.offsetTop - pad;
    else if (item.offsetTop + item.offsetHeight + pad > node.scrollTop + node.clientHeight) {
      node.scrollTop = item.offsetTop + item.offsetHeight + pad - node.clientHeight;
    }
  }, [active, id, place]);

  return createPortal(
    <ul
      ref={box}
      className="k-options"
      data-kit="OptionList"
      data-kit-list=""
      id={id}
      role="listbox"
      aria-label={label}
      data-placed={place ? "yes" : "no"}
      style={place ? { top: place.top, left: place.left, height: place.height } : undefined}
      // A press keeps the focus in the text box the list belongs to.
      onMouseDown={(event) => event.preventDefault()}
      // The pointer highlights what it moves over. Only a pointer that moved:
      // the list scrolling under a still one must not take the highlight
      // from the keyboard.
      onMouseMove={(event) => {
        const was = pointer.current;
        pointer.current = { x: event.clientX, y: event.clientY };
        if (was !== null && was.x === event.clientX && was.y === event.clientY) return;
        const row = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
        const item = row === null ? undefined : items.find((one) => optionId(id, one.id) === row.id);
        if (item !== undefined && item.id !== active) onActive(item.id);
      }}
    >
      {items.map((item) => (
        <Row
          key={item.id}
          lead={item.lead}
          lines="one"
          title={item.title}
          note={item.note}
          label={item.label}
          option={{
            id: optionId(id, item.id),
            active: item.id === active,
            onPick: () => onPick(item.id),
          }}
        />
      ))}
    </ul>,
    document.body,
  );
}
