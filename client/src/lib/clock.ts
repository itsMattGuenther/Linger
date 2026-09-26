/**
 * The clock the UI reads.
 *
 * Anything that says "40m" or fades with age has to be recomputed as time
 * passes, and a component that owns its own timer is a component that ticks on
 * its own schedule — two of them side by side disagree by up to a minute. One
 * hook, one interval per subscriber, everything derived from the number it
 * hands back.
 *
 * Note this returns a moment, never a duration. Callers take `now` as an
 * argument so the arithmetic stays pure and testable (`stream/time.ts`,
 * `lib/roster.ts`).
 */
import { useEffect, useState } from "react";

/** A minute: fine enough for "40m", coarse enough to cost nothing. */
const MINUTE_MS = 60_000;

/** `Date.now()`, refreshed on a timer, so relative times keep up. */
export function useNow(everyMs: number = MINUTE_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
