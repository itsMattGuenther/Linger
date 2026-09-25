import type { CSSProperties, ReactNode } from "react";
import { MARKER_WORDS, type MarkerState } from "./presence";
import "./Marker.css";

/** A palette key such as "azure". Never a color value (AGENTS rule 12). */
export type ColorKey = string;

export interface MarkerPerson {
  color: ColorKey;
  state: MarkerState;
}

/** A palette key becomes a color only through the generated palette. */
function colorStyle(color: ColorKey): CSSProperties {
  const key = /^[a-z]{2,16}$/.test(color) ? color : "slate";
  return { "--marker-color": `var(--name-${key})` } as CSSProperties;
}

/**
 * A person's presence, in their color: a plain dot when they're here or
 * around, a crescent moon when they're away, a dimmed dot when they're idle or
 * offline. The same at every size.
 *
 * This is the only marker in the app. Every list, card, tab and chip draws
 * presence with it, so one state never looks two ways.
 */
export function Marker({
  color,
  state,
  size = "md",
  typing = false,
  label,
}: MarkerPerson & {
  size?: "md" | "sm";
  /** Breathing: they're typing. */
  typing?: boolean;
  /** Give it a name for assistive technology; otherwise it is decoration. */
  label?: string;
}) {
  return (
    <span
      className="k-marker"
      data-kit="Marker"
      data-state={state}
      data-size={size}
      data-typing={typing ? "yes" : undefined}
      style={colorStyle(color)}
      role={label ? "img" : undefined}
      aria-label={label ? `${label}, ${MARKER_WORDS[state]}` : undefined}
      aria-hidden={label ? undefined : "true"}
    >
      {state === "away" ? (
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M12.8 10.2A5.5 5.5 0 0 1 5.8 3.2a5.5 5.5 0 1 0 7 7z" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The fixed lead column every list row shares. Whatever sits in it — one
 * marker, a group's markers, a room's #, or nothing — the text after it starts
 * at the same place.
 */
export function MarkerSlot({ children }: { children?: ReactNode }) {
  return (
    <span className="k-slot" data-kit="MarkerSlot" aria-hidden="true">
      {children}
    </span>
  );
}

/** A room's lead: the #, the same color for every room. */
export function HashMark() {
  return <span className="k-hash">#</span>;
}

/**
 * A group DM's people, arranged inside the one slot: two on a diagonal, three
 * in a triangle, four in a square. More than four show the first four.
 */
export function GroupMarker({ people }: { people: MarkerPerson[] }) {
  const shown = people.slice(0, 4);
  if (shown.length === 1 && shown[0]) {
    return <Marker color={shown[0].color} state={shown[0].state} />;
  }
  return (
    <span className="k-group" data-kit="GroupMarker" data-count={shown.length} aria-hidden="true">
      {shown.map((person, index) => (
        <Marker key={index} color={person.color} state={person.state} size="sm" />
      ))}
    </span>
  );
}

/** Who's in a room, as a short row of small markers. */
export function MarkerCluster({ people, max = 5 }: { people: MarkerPerson[]; max?: number }) {
  return (
    <span className="k-cluster" data-kit="MarkerCluster" aria-hidden="true">
      {people.slice(0, max).map((person, index) => (
        <Marker key={index} color={person.color} state={person.state} size="sm" />
      ))}
    </span>
  );
}
