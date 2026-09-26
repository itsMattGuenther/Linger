import { type KeyboardEvent, useRef } from "react";
import { Icon, type IconName } from "./Icon";
import "./NavList.css";

export type NavEntry<K extends string> =
  /** A heading over the items after it, with an optional second line (a server's name). */
  | { kind: "group"; label: string; sub?: string }
  | { kind: "item"; key: K; label: string; icon: IconName };

/**
 * A column of places to go, like Settings' sections: an icon and a word per
 * place, in groups. It is a vertical tab list: the arrows move between items
 * and show them, Home and End jump to the ends, and only the showing item is
 * in the tab order.
 */
export function NavList<K extends string>({
  label,
  entries,
  current,
  onSelect,
  panelId,
}: {
  label: string;
  entries: readonly NavEntry<K>[];
  current: K;
  onSelect: (key: K) => void;
  /** The id of the panel the items control, for `aria-controls`. */
  panelId?: string;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  const items = entries.filter((entry): entry is Extract<NavEntry<K>, { kind: "item" }> => entry.kind === "item");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.key === current);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    const target = next === null ? undefined : items[next];
    if (!target) return;
    event.preventDefault();
    onSelect(target.key);
    list.current?.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(target.key)}"]`)?.focus();
  };

  return (
    <div ref={list} className="k-nav" data-kit="NavList" role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKeyDown}>
      {entries.map((entry) =>
        entry.kind === "group" ? (
          <div key={`group-${entry.label}`} className="k-nav-group" data-sub={entry.sub ? "yes" : undefined} role="presentation">
            <span className="k-nav-group-label">{entry.label}</span>
            {entry.sub ? <span className="k-nav-group-sub">{entry.sub}</span> : null}
          </div>
        ) : (
          <button
            key={entry.key}
            type="button"
            role="tab"
            className="k-nav-item"
            data-kit="NavItem"
            data-kit-control=""
            data-nav-key={entry.key}
            aria-selected={entry.key === current}
            aria-controls={panelId}
            tabIndex={entry.key === current ? 0 : -1}
            onClick={() => onSelect(entry.key)}
          >
            <Icon name={entry.icon} size="md" />
            <span className="k-nav-text">{entry.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
