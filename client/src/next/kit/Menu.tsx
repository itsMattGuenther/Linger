import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import "./Menu.css";

/** Distance from the trigger, and the closest a menu may come to an edge. */
const GAP = 4;
const EDGE = 8;

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Destructive: drawn in the danger color. */
  tone?: "danger";
  /**
   * An on/off choice (a `menuitemcheckbox`), like a server's Quiet: true
   * or false says which, and a tick shows when it's on. Leave out for a
   * plain action.
   */
  checked?: boolean;
  onSelect: () => void;
}

/** Every item the keyboard moves through, whatever kind. */
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';

/** Where the menu was opened from: the trigger's box in the window. */
export interface MenuAnchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export type MenuCloseReason = "escape" | "outside" | "select" | "tab";

/**
 * A short list of actions that floats by the button that opened it: a
 * message's reply, edit and delete. Drawn in a portal, so a scrolling list or
 * a window edge can never cut it off.
 *
 * Keyboard: the first item is focused when it opens (and again when its items
 * change, for a confirm step); arrows, Home and End move; Enter chooses;
 * Escape and Tab close. A click outside closes it. Returning focus to the
 * trigger is the caller's, which knows what the trigger was.
 */
export function Menu({
  label,
  items,
  anchor,
  onClose,
}: {
  label: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  onClose: (reason: MenuCloseReason) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const itemKey = items.map((item) => item.id).join("|");

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const size = node.getBoundingClientRect();
    // Below the trigger, its right edge on the trigger's; above when there is
    // no room below. Always inside the window.
    const below = anchor.bottom + GAP + size.height <= window.innerHeight - EDGE;
    const top = below ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - size.height);
    const left = Math.min(Math.max(anchor.right - size.width, EDGE), window.innerWidth - EDGE - size.width);
    setPlace({ top, left });
  }, [anchor.bottom, anchor.right, anchor.top, itemKey]);

  // Only once it's placed: an item is not focusable while the menu is
  // hidden for measuring.
  const placed = place !== null;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [itemKey, placed]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      onClose("outside");
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = all.findIndex((item) => item === document.activeElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (at + 1) % all.length;
    else if (event.key === "ArrowUp") next = (at - 1 + all.length) % all.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = all.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose("escape");
      return;
    } else if (event.key === "Tab") {
      event.preventDefault();
      onClose("tab");
      return;
    }
    if (next === null) return;
    event.preventDefault();
    all[next]?.focus();
  };

  return createPortal(
    <div
      ref={box}
      className="k-menu"
      data-kit="Menu"
      role="menu"
      aria-label={label}
      data-placed={place ? "yes" : "no"}
      style={place ? { top: place.top, left: place.left } : undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked}
          className="k-menu-item"
          data-kit="MenuItem"
          data-kit-control=""
          data-tone={item.tone}
          tabIndex={-1}
          onClick={() => {
            item.onSelect();
          }}
        >
          <span className="k-menu-icon" aria-hidden="true">
            {item.icon ? <Icon name={item.icon} size="md" /> : null}
          </span>
          <span className="k-menu-text">{item.label}</span>
          {item.checked ? (
            <span className="k-menu-tick" aria-hidden="true">
              <Icon name="check" size="sm" />
            </span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
