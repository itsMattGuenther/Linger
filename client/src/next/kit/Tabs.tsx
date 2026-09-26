import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "./IconButton";
import { Marker, type MarkerPerson } from "./Marker";
import { VoiceGlyph } from "./VoiceGlyph";
import "./Tabs.css";

/** A press has to travel this far along the row before it's a drag and not a click. */
const DRAG_START_PX = 4;

/** A palette key becomes a color only through the generated palette. */
function stripeStyle(key: string | undefined): CSSProperties | undefined {
  if (!key || !/^[a-z]{2,16}$/.test(key)) return undefined;
  return { "--tab-stripe": `var(--name-${key})` } as CSSProperties;
}

/** What leads a tab's title: a room's #, or a one-to-one DM's person. */
export type TabLead = { kind: "room" } | { kind: "person"; person: MarkerPerson };

export interface TabItem {
  id: string;
  /** What the tab shows: a room's name (the # comes from `lead`), a DM's people. */
  title: ReactNode;
  lead?: TabLead;
  /** The tab's accessible name, like "#general" or "DM with Jules". */
  label: string;
  /** Something new arrived while another tab was showing: bold, never a count. */
  fresh?: boolean;
  /** Voice here: `mine` when you're in it, `others` when only others are. */
  voice?: "mine" | "others";
  speaking?: boolean;
  closable?: boolean;
  /**
   * With several servers, the server's palette key (never a color value): a
   * thin stripe along the tab's top says which server it belongs to.
   */
  stripe?: string;
}

export interface TabStripProps {
  /** The tab list's accessible name, like "Conversations". */
  label: string;
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  /** Drag a tab along the row to here (its new place, from 0). Leave out for tabs that don't move. */
  onMove?: (id: string, to: number) => void;
  /** The id prefix of the panels the tabs control, for `aria-controls`. */
  panelIdPrefix?: string;
}

/**
 * A row of tabs, like a browser's. Keyboard: arrows move between tabs (and
 * show them), Home and End jump to the ends, Delete closes the focused tab.
 * Only the showing tab is in the tab order; the rest are reached by arrows.
 * When there are more tabs than fit, the row scrolls sideways and keeps the
 * showing tab in view. With `onMove`, a tab can be dragged along the row:
 * the others slide aside to show where it will land, and a press that moves
 * less than a few pixels is still a click.
 */
export function TabStrip({ label, tabs, activeId, onSelect, onClose, onMove, panelIdPrefix }: TabStripProps) {
  const strip = useRef<HTMLDivElement | null>(null);
  // The press that may become a drag, and where every tab was when it began.
  const pressed = useRef<{ id: string; x: number; from: number; rects: DOMRect[]; pointer: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; from: number; to: number; step: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string, index: number) => {
    if (!onMove || event.button !== 0 || (event.target instanceof Element && event.target.closest(".k-tab-close"))) return;
    const rects = [...(strip.current?.querySelectorAll<HTMLElement>(".k-tab") ?? [])].map((node) => node.getBoundingClientRect());
    pressed.current = { id, x: event.clientX, from: index, rects, pointer: event.pointerId, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = pressed.current;
    if (!held || event.pointerId !== held.pointer) return;
    const dx = event.clientX - held.x;
    if (!held.moved) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      held.moved = true;
      // Only now: capturing on the press would take the click from the tab's button.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const own = held.rects[held.from];
    if (!own) return;
    const center = own.left + own.width / 2 + dx;
    const to = held.rects.filter((rect, index) => index !== held.from && rect.left + rect.width / 2 < center).length;
    const next = held.rects[held.from + 1] ?? held.rects[held.from - 1];
    const gap = next ? Math.abs(next.left - own.left) - (next.left > own.left ? own.width : next.width) : 0;
    setDrag({ id: held.id, dx, from: held.from, to, step: own.width + gap });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const held = pressed.current;
    pressed.current = null;
    if (!held || event.pointerId !== held.pointer || !held.moved) return;
    const landed = drag;
    setDrag(null);
    onSelect(held.id);
    if (landed && landed.to !== landed.from) onMove?.(landed.id, landed.to);
  };
  const onPointerCancel = () => {
    pressed.current = null;
    setDrag(null);
  };
  /** How far a tab slides while another is dragged past it. */
  const shiftOf = (index: number): number => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dx;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.step;
    return 0;
  };
  const [overflow, setOverflow] = useState<"none" | "start" | "end" | "both">("none");

  // Which edges have tabs hidden past them, so the strip can fade those.
  const measure = useCallback(() => {
    const node = strip.current;
    if (!node) return;
    const before = node.scrollLeft > 1;
    const after = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setOverflow(before && after ? "both" : before ? "start" : after ? "end" : "none");
  }, []);

  useLayoutEffect(() => {
    const node = strip.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, tabs.length]);

  useEffect(() => {
    const tab = strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const focusTab = (id: string) => {
    strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    if (index < 0 || tabs.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "Delete" && onClose && tabs[index]?.closable !== false) {
      event.preventDefault();
      onClose(activeId);
      return;
    }
    const target = next === null ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    onSelect(target.id);
    focusTab(target.id);
  };

  return (
    <div
      ref={strip}
      className="k-tabs"
      data-kit="TabStrip"
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-overflow={overflow === "none" ? undefined : overflow}
      data-dragging={drag ? "yes" : undefined}
      onKeyDown={onKeyDown}
      onScroll={measure}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const shift = shiftOf(index);
        return (
          <div
            key={tab.id}
            className="k-tab"
            data-tab-id={tab.id}
            data-active={active ? "yes" : undefined}
            data-fresh={tab.fresh && !active ? "yes" : undefined}
            data-stripe={tab.stripe ? "yes" : undefined}
            data-dragged={drag?.id === tab.id ? "yes" : undefined}
            style={{ ...stripeStyle(tab.stripe), ...(shift === 0 ? {} : { transform: `translateX(${shift}px)` }) }}
            role="presentation"
            onPointerDown={(event) => onPointerDown(event, tab.id, index)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          >
            <button
              type="button"
              role="tab"
              className="k-tab-main"
              data-kit="Tab"
              data-kit-control=""
              aria-selected={active}
              aria-label={tab.label}
              aria-controls={panelIdPrefix ? `${panelIdPrefix}${tab.id}` : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
            >
              {tab.lead?.kind === "person" ? <Marker {...tab.lead.person} size="sm" /> : null}
              <span className="k-tab-title">
                {tab.lead?.kind === "room" ? (
                  <span className="k-tab-hash" aria-hidden="true">
                    #
                  </span>
                ) : null}
                {tab.title}
              </span>
              {tab.voice ? <VoiceGlyph speaking={tab.speaking ?? false} mine={tab.voice === "mine"} /> : null}
            </button>
            {onClose && tab.closable !== false ? (
              <span className="k-tab-close">
                <IconButton icon="close" label={`Close ${tab.label}`} size="sm" skipTab onClick={() => onClose(tab.id)} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
