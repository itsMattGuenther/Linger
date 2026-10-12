/**
 * "Show my local time" (#604, SPEC §4.6): what time it is for somebody who
 * shares their clock, said the way their card says it.
 *
 * Nothing here is sent anywhere. The zone name comes from the person's own
 * app (this computer's clock, `deviceTimeZone`), the server only keeps it,
 * and every reader works the time out with their own engine's zone data.
 */

import type { User } from "../generated/User";

/** This computer's time-zone name, like "America/Chicago", or null when the engine won't say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : null;
  } catch {
    return null;
  }
}

/**
 * The zone to move your shared clock to on a server (#604), or null to leave
 * it: only while it's on (`held`), only when this computer's clock says
 * somewhere else, and once per zone (`asked`, the zone already sent there),
 * so a server that refuses isn't asked again on every event.
 */
export function zoneToMove(held: string | undefined | null, here: string | null, asked: string | undefined): string | null {
  if (held === undefined || held === null || here === null || held === here || asked === here) return null;
  return here;
}

/** What "Show my local time" says on a server too old to keep your time zone (#640). */
export const LOCAL_TIME_NEEDS_UPDATE = "This server needs updating before it can show your time.";

/**
 * Whether the server kept the time zone it was sent (#640). One from before
 * #604 doesn't know the field: it keeps nothing and answers with your profile
 * as it was, so the switch would flip on and quietly back off. Turned on and
 * answered without a zone, it says why; turned off, or kept, it's null.
 */
export function localTimeProblem(zone: string, saved: Pick<User, "time_zone">): string | null {
  return zone !== "" && (saved.time_zone ?? "") === "" ? LOCAL_TIME_NEEDS_UPDATE : null;
}

/**
 * "3:12 AM for Jules": their clock at `now`, and their name. When their
 * calendar is on another day than the reader's, it says which: "3:12 AM for
 * Jules, the next day" or "11:40 PM for Jules, the day before", the words a
 * written time uses (#584).
 *
 * Null when this engine doesn't know the zone: the card then says nothing,
 * rather than a wrong time. `here` and `locale` are the reader's; left out,
 * they're this computer's.
 */
export function timeFor(zone: string, name: string, now: number, here?: string, locale?: string): string | null {
  const theirs = dayIn(zone, now);
  if (theirs === null) return null;
  const clock = clockFormat(locale, zone).format(now);
  const mine = dayIn(here ?? deviceTimeZone() ?? "UTC", now);
  const shift = mine === null ? 0 : Math.round((theirs - mine) / 86_400_000);
  if (shift === 1) return `${clock} for ${name}, the next day`;
  if (shift === -1) return `${clock} for ${name}, the day before`;
  return `${clock} for ${name}`;
}

/** Midnight UTC of the calendar day it is in `zone` at `at`, or null for a zone this engine doesn't know. */
function dayIn(zone: string, at: number): number | null {
  const format = partsFormat(zone);
  if (format === null) return null;
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of format.formatToParts(at)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return Date.UTC(year, month - 1, day);
}

// Formatters are slow to build, and a card asks every minute, so each is
// built once (as in writtenTime.ts).
const PARTS = new Map<string, Intl.DateTimeFormat | null>();
const CLOCKS = new Map<string, Intl.DateTimeFormat>();

function partsFormat(zone: string): Intl.DateTimeFormat | null {
  let format = PARTS.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" });
    } catch {
      // A zone this engine's data doesn't know.
      format = null;
    }
    PARTS.set(zone, format);
  }
  return format;
}

function clockFormat(locale: string | undefined, zone: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${zone}`;
  let format = CLOCKS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone });
    CLOCKS.set(key, format);
  }
  return format;
}
