import { useMemo, useRef } from "react";
import { seatTalkers } from "../core/seats";

/**
 * The seats up front in a big voice room (#197): who just talked, kept still
 * (core/seats.ts has the rule). `everyone` is who is in the room, you left
 * out, in the server's order; `talking` who is talking now, which is known
 * only while you're in voice. The memory of who spoke when lives here, per
 * place that shows seats, and goes when that place does.
 */
export function useTalkSeats(everyone: readonly string[], talking: ReadonlySet<string>, count: number): readonly string[] {
  const spokeAt = useRef(new Map<string, number>());
  const held = useRef<string[]>([]);
  const clock = useRef(0);
  // The room as one value, so a new array with the same people changes nothing.
  const key = everyone.join("\n");
  return useMemo(() => {
    clock.current += 1;
    for (const id of talking) spokeAt.current.set(id, clock.current);
    held.current = seatTalkers(held.current, count, key === "" ? [] : key.split("\n"), talking, spokeAt.current);
    return held.current;
  }, [key, talking, count]);
}
