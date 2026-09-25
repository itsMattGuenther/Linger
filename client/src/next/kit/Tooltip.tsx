import { type FocusEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

/** Distance from the anchor, and the closest a tooltip may come to an edge. */
const GAP = 6;
const EDGE = 8;

/**
 * Short help text for an icon-only control, drawn in a portal so a window's
 * clipping or a scrolling list can never cut it off.
 *
 * It repeats the control's accessible name for sighted mouse and keyboard
 * users, so it is hidden from assistive technology: screen readers already
 * have the label.
 */
export function TooltipBubble({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const bubble = useRef<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node) return;
    const a = anchor.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    const below = a.bottom + GAP + b.height <= window.innerHeight - EDGE;
    const top = below ? a.bottom + GAP : a.top - GAP - b.height;
    const centered = a.left + a.width / 2 - b.width / 2;
    const left = Math.min(Math.max(centered, EDGE), window.innerWidth - EDGE - b.width);
    setPlace({ top, left });
  }, [anchor]);

  return createPortal(
    <span
      ref={bubble}
      className="k-tooltip"
      data-kit="Tooltip"
      aria-hidden="true"
      data-placed={place ? "yes" : "no"}
      style={place ? { top: place.top, left: place.left } : undefined}
    >
      {children}
    </span>,
    document.body,
  );
}

/**
 * Show a tooltip while the pointer is over the anchor or it has keyboard
 * focus. Returns the props to spread on the anchor and the bubble to render.
 */
export function useTooltip(text: ReactNode) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const show = (event: { currentTarget: HTMLElement }) => setAnchor(event.currentTarget);
  const hide = () => setAnchor(null);
  return {
    anchorProps: {
      onPointerEnter: show,
      onPointerLeave: hide,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.currentTarget.matches(":focus-visible")) show(event);
      },
      onBlur: hide,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Escape") hide();
      },
    },
    bubble: anchor ? <TooltipBubble anchor={anchor}>{text}</TooltipBubble> : null,
  };
}
