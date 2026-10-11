/**
 * One clock for everything that shows a time that moves on by the minute
 * (#604: "3:12 AM for Jules" on cards and Knock buttons). However many
 * cards and rows are listening, there is one timer, set for the next turn of
 * the minute, and none at all while nobody listens.
 *
 * The minute is read from `Date.now()` at each tick, so a late tick (a hidden
 * window's timers are slowed, #594) catches up rather than drifting.
 */

const listeners = new Set<() => void>();
let minute = minuteOf(Date.now());
let timer: ReturnType<typeof setTimeout> | null = null;

function minuteOf(at: number): number {
  return at - (at % 60_000);
}

function tick(): void {
  timer = null;
  const now = Date.now();
  const next = minuteOf(now);
  if (next !== minute) {
    minute = next;
    for (const listener of [...listeners]) listener();
  }
  schedule(now);
}

function schedule(now: number): void {
  if (listeners.size === 0 || timer !== null) return;
  // A few milliseconds past the turn, so the tick never lands just before it.
  timer = setTimeout(tick, 60_000 - (now % 60_000) + 20);
}

/** Listen for the minute turning. Returns the way to stop. */
export function subscribeMinute(listener: () => void): () => void {
  listeners.add(listener);
  // Woken after a while with nobody listening: start from the true minute.
  minute = minuteOf(Date.now());
  schedule(Date.now());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** The start of the current minute, in milliseconds: the same value until the minute turns. */
export function currentMinute(): number {
  return minute;
}

/** How many are listening, for tests. */
export function minuteListeners(): number {
  return listeners.size;
}
