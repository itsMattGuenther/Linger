/**
 * The seats up front in a big voice room (#197, decided 2026-10-06): a few
 * places for the people who just talked, so a raid of fifty shows who's
 * speaking instead of a wall of fifty chips. Pure; `app/useTalkSeats.ts`
 * keeps the memory between draws.
 *
 * The rule that keeps it calm: a seat changes hands only when somebody who
 * has no seat starts talking, and it goes to the seat of whoever spoke
 * longest ago and isn't talking now. Nobody moves while they talk, and a seat
 * held by somebody who just finished stays theirs until it's needed. Seats
 * left empty (a room filling up, somebody leaving) are filled in the server's
 * order, so a new room starts with the first people who joined, as before.
 */

/**
 * The seats after this moment. `held` is the seats as they were (ids, in seat
 * order), `everyone` who is in the room now (server order, you left out),
 * `talking` who is talking now, and `spokeAt` when each person last talked
 * (larger is later; nobody in it has never talked). Returns at most `count`
 * ids, never one twice, all of them in `everyone`.
 */
export function seatTalkers(
  held: readonly string[],
  count: number,
  everyone: readonly string[],
  talking: ReadonlySet<string>,
  spokeAt: ReadonlyMap<string, number>,
): string[] {
  const here = new Set(everyone);
  // Seats keep their places; somebody who left leaves a gap.
  const seats: (string | null)[] = Array.from({ length: count }, (_, at) => {
    const id = held[at];
    return id !== undefined && here.has(id) ? id : null;
  });
  const seated = () => new Set(seats.filter((id): id is string => id !== null));

  for (const id of everyone) {
    if (!talking.has(id) || seated().has(id)) continue;
    const at = freeSeat(seats, talking, spokeAt);
    if (at !== null) seats[at] = id;
  }

  // Gaps take the first people in the room's order who have no seat yet.
  const waiting = everyone.filter((id) => !seated().has(id));
  for (let at = 0; at < seats.length; at += 1) {
    if (seats[at] !== null) continue;
    const next = waiting.shift();
    if (next === undefined) break;
    seats[at] = next;
  }
  return seats.filter((id): id is string => id !== null);
}

/**
 * The seat a new talker takes: a gap first, then the seat of whoever spoke
 * longest ago among those not talking now (somebody who never spoke counts
 * as longest ago). Null when every seat is somebody talking right now.
 */
function freeSeat(seats: readonly (string | null)[], talking: ReadonlySet<string>, spokeAt: ReadonlyMap<string, number>): number | null {
  const gap = seats.indexOf(null);
  if (gap >= 0) return gap;
  let best: number | null = null;
  let oldest = Infinity;
  for (let at = 0; at < seats.length; at += 1) {
    const id = seats[at];
    if (id === null || id === undefined || talking.has(id)) continue;
    const when = spokeAt.get(id) ?? -Infinity;
    if (when < oldest) {
      oldest = when;
      best = at;
    }
  }
  return best;
}
