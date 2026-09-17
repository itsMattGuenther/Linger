/**
 * Turning timestamps into what the stream shows: session labels, clock times,
 * and how faded a message body is.
 *
 * All of it is pure and takes `now` as an argument rather than reading the
 * clock, because "yesterday afternoon" is only correct relative to a moment and
 * that moment has to be testable.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A group breaks when the same author goes quiet this long (SPEC §4.7). */
export const GROUP_BREAK_MS = 10 * MINUTE_MS;
/** A session breaks when the *room* goes quiet this long (SPEC §4.7). */
export const SESSION_BREAK_MS = 3 * HOUR_MS;

/** The part of the day a timestamp falls in. */
type Part = "late night" | "morning" | "afternoon" | "evening" | "night";

function partOf(hour: number): Part {
  if (hour < 5) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `from` to `to`. Rounding is what makes this survive
 * daylight saving, where a "day" is 23 or 25 hours long.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/**
 * The natural-language label on a session divider: `SATURDAY MORNING`,
 * `YESTERDAY AFTERNOON`, `LATE TUESDAY NIGHT` (SPEC §4.7 — the CSS uppercases
 * it, so this returns ordinary sentence-shaped text).
 *
 * Weekday and date come from `toLocaleDateString` with no locale argument, so
 * they land in whatever language and date order the machine is set to.
 */
export function sessionLabel(at: number, now: number): string {
  const when = new Date(at);
  const part = partOf(when.getHours());

  // The small hours belong to the evening before: 2am Wednesday is "late
  // Tuesday night", which is how people say it. Building the previous day by
  // date rather than subtracting 24 hours keeps it right across a DST shift.
  const anchor =
    part === "late night"
      ? new Date(when.getFullYear(), when.getMonth(), when.getDate() - 1)
      : when;

  // Clamped because a clock that is behind the server's makes this negative,
  // and "in 2 days morning" is worse than being slightly wrong for a minute.
  const today = new Date(now);
  const ago = Math.max(0, daysBetween(anchor, today));
  const weekday = anchor.toLocaleDateString(undefined, { weekday: "long" });
  const dated =
    anchor.getFullYear() === today.getFullYear()
      ? anchor.toLocaleDateString(undefined, { month: "long", day: "numeric" })
      : anchor.toLocaleDateString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric",
        });

  // Past a week the weekday alone stops locating anything, so the date joins it.
  const suffix = ago < 7 ? "" : `, ${dated}`;

  if (part === "late night") {
    if (ago === 1) return `late last night${suffix}`;
    return `late ${weekday} night${suffix}`;
  }
  if (part === "night") {
    if (ago === 0) return "tonight";
    if (ago === 1) return "last night";
    return `${weekday} night${suffix}`;
  }
  if (ago === 0) return `this ${part}`;
  if (ago === 1) return `yesterday ${part}`;
  return `${weekday} ${part}${suffix}`;
}

/** The local time on a message group header. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The full date and time, for the tooltip on a timestamp. */
export function fullTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  });
}

/**
 * Date and time on one line, for a search hit (SPEC §4.12).
 *
 * Shorter than `fullTime`, which spells the weekday out and is a tooltip's
 * worth of words. A result line already carries a name, a room and a snippet;
 * the date has to fit beside them and still say which year.
 */
export function hitTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * How opaque a message body is, by age (SPEC §5.6). Scrolling up should feel
 * like walking into the past, and the floor is 78% — old is not unreadable.
 */
export function ageOpacity(at: number, now: number): number {
  const age = now - at;
  if (age < HOUR_MS) return 1;
  if (age < DAY_MS) return 0.88;
  return 0.78;
}
