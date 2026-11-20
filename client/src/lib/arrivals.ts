/**
 * When each person last arrived, for a Shimmer name's light (#532,
 * `kit/Name.tsx`).
 *
 * The light crosses a name in the list three times when its person arrives:
 * the first time this page sees them lit (Linger starting), and each time they
 * come back from idle, away or offline. It belongs to the person, not to the
 * spot their name is drawn in. The list rebuilds a name whenever the layout
 * around it changes shape (a folded server's line going from a room to voice,
 * the voice dock growing past its seats), and a light that started with the
 * name crossed again every time, for nobody new. Here, every name of one
 * person crosses in the same 12 seconds, in step, and a name drawn after them
 * is still.
 *
 * Lit is the list's own rule (`next/core/list.ts`): here or around, or in a
 * room, which a room's voice counts as (`shownState`), never idle, away or
 * offline. Only a connected server is looked at, and one that isn't keeps
 * what it last showed, so a dropped connection, a resume or a second `ready`
 * isn't everybody arriving at once.
 */
import type { GatewayState } from "./gateway";
import { shownState, voiceRoomsOf } from "./roster";

/** One crossing of a name, as long as `kit/Name.css` draws it (4s). */
export const CROSSING_MS = 4000;
/** Crossings when somebody arrives. */
export const ARRIVAL_ROUNDS = 3;
/** How long an arrival's light lasts. */
export const ARRIVAL_MS = CROSSING_MS * ARRIVAL_ROUNDS;

/** Who was lit on each server, by its address, the last time it was connected. */
export type Seen = ReadonlyMap<string, ReadonlySet<string>>;

/** Who is lit on one server, as the list draws them. */
export function litOn(state: GatewayState): Set<string> {
  const voiceRooms = voiceRoomsOf(state.voice, state.rooms);
  const lit = new Set<string>();
  for (const entry of state.presence) {
    const shown = shownState(entry.state, voiceRooms.has(entry.user_id));
    if (shown === "in_room" || shown === "around") lit.add(entry.user_id);
  }
  return lit;
}

/**
 * Who arrived since the last look: lit now on a connected server, and not lit
 * there last time (or the server not seen before). A server that isn't
 * connected keeps its last look; one that's gone is forgotten.
 */
export function arrivalsBetween(before: Seen, states: Readonly<Record<string, GatewayState>>): { seen: Map<string, ReadonlySet<string>>; arrived: string[] } {
  const seen = new Map<string, ReadonlySet<string>>();
  const arrived: string[] = [];
  for (const [server, state] of Object.entries(states)) {
    const last = before.get(server);
    if (state.status.kind !== "ready") {
      if (last) seen.set(server, last);
      continue;
    }
    const lit = litOn(state);
    for (const id of lit) if (!last?.has(id)) arrived.push(id);
    seen.set(server, lit);
  }
  return { seen, arrived };
}

/** One person's latest arrival, and whether its light is already over. */
export interface Arrival {
  /** When, on `performance.now()`'s clock. */
  at: number;
  /** Its crossings ended before their time: rested by a test, say. */
  ended: boolean;
}

/**
 * Where a name's light is at `now`: how far into an arrival's crossings
 * (milliseconds), or null when there's no light to draw. A name drawn later
 * than its person's arrival starts that far in, so it crosses in step with
 * their other names and ends with them.
 */
export function lightAt(arrival: Arrival | undefined, now: number): number | null {
  if (!arrival || arrival.ended) return null;
  const into = now - arrival.at;
  return into >= 0 && into < ARRIVAL_MS ? into : null;
}

// --- The page's one record ----------------------------------------------------

let seen: Seen = new Map();
const arrivals = new Map<string, Arrival>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Look at every server again (the list window does, as they change). */
export function watchArrivals(states: Readonly<Record<string, GatewayState>>, now = performance.now()): void {
  const next = arrivalsBetween(seen, states);
  seen = next.seen;
  if (next.arrived.length === 0) return;
  for (const id of next.arrived) arrivals.set(id, { at: now, ended: false });
  changed();
}

/** A person's latest arrival, kept as the same object until it changes. */
export function arrivalOf(user: string): Arrival | undefined {
  return arrivals.get(user);
}

/** That arrival's light is over, for every name of theirs. */
export function endArrival(user: string, at: number): void {
  const arrival = arrivals.get(user);
  if (!arrival || arrival.at !== at || arrival.ended) return;
  arrivals.set(user, { at, ended: true });
  changed();
}

export function subscribeArrivals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
