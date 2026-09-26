import type { PresenceState } from "../../generated/PresenceState";
import type { User } from "../../generated/User";
import { paletteKey } from "../../lib/names";

/**
 * How a person's presence is drawn. Five states on the wire (SPEC §4.3), five
 * markers here, and one function between them so no surface invents its own.
 */
export type MarkerState = "here" | "around" | "idle" | "away" | "offline";

export function markerStateOf(presence: PresenceState): MarkerState {
  switch (presence) {
    case "in_room":
      return "here";
    case "around":
      return "around";
    case "idle":
      return "idle";
    case "away":
      return "away";
    case "offline":
      return "offline";
  }
}

/** The words for a marker, for screen readers and tooltips. */
export const MARKER_WORDS: Record<MarkerState, string> = {
  here: "here",
  around: "around",
  idle: "idle",
  away: "away",
  offline: "offline",
};

/**
 * A person's marker: their palette color (a gradient name uses its first
 * color) and their presence. The one way a person becomes a marker, so the
 * same person looks the same in every list, tab, strip and card.
 */
export function markerOf(user: User, presence: PresenceState): { color: string; state: MarkerState } {
  return { color: paletteKey(user) ?? "slate", state: markerStateOf(presence) };
}
