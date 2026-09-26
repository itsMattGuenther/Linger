import type { PresenceState } from "../../generated/PresenceState";
import type { User } from "../../generated/User";
import { paletteKey } from "../../lib/names";
import { type MarkerPerson, markerStateOf } from "../kit";

/** A person's marker: their palette color and their presence. One rule for every screen. */
export function markerFor(user: User, state: PresenceState): MarkerPerson {
  return { color: paletteKey(user) ?? "slate", state: markerStateOf(state) };
}
