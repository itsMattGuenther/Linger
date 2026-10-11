/**
 * Times written with a zone, read in your own clock (#584, SPEC §4.7).
 *
 * A message of the day says "Friday @ 8PM CDT", and everybody outside
 * Central time does the sum in their head. This finds such times in a run of
 * words so the app can say what they are here: "9:00 PM for you".
 *
 * Nothing is stored and nothing crosses the wire: it reads the words already
 * on screen, so it works on old messages too.
 *
 * What counts as a time, on purpose narrowly so it rarely underlines anything
 * else:
 * - a clock time: `8PM`, `8 pm`, `8:30 p.m.`, or a 24-hour `20:00`. A bare
 *   number (`at 8 PT`) is not one: `5 PT` might be anything.
 * - then a zone that means one place: `UTC`, `GMT`, `UTC+2`, `CDT`, `CET`, or
 *   a US zone by name (`Eastern`, `Pacific Time`). Abbreviations that mean
 *   more than one place (CST, IST, BST) are left alone rather than guessed.
 *
 * The day is the one the words were written on, in the writer's zone: the
 * time is placed on that date, not today's, so a summer "8pm Eastern" read in
 * December is still summer time.
 */

/** Where a written zone puts its clock: a fixed offset, or a place whose clock changes. */
type Zone = { offset: number } | { place: string };

/**
 * Zones by what people write. US abbreviations read as the place they name,
 * so "8PM EST" in July is Eastern summer time: nearly everybody who writes
 * EST in July means the clock in New York. MST and HST stay fixed, because
 * Arizona and Hawaii keep them all year. Everything else is the fixed offset
 * it says.
 */
const ZONES: Readonly<Record<string, Zone>> = {
  UTC: { offset: 0 },
  GMT: { offset: 0 },
  EST: { place: "America/New_York" },
  EDT: { place: "America/New_York" },
  ET: { place: "America/New_York" },
  CDT: { place: "America/Chicago" },
  CT: { place: "America/Chicago" },
  MDT: { place: "America/Denver" },
  MT: { place: "America/Denver" },
  MST: { offset: -7 * 60 },
  PST: { place: "America/Los_Angeles" },
  PDT: { place: "America/Los_Angeles" },
  PT: { place: "America/Los_Angeles" },
  AKST: { place: "America/Anchorage" },
  AKDT: { place: "America/Anchorage" },
  HST: { offset: -10 * 60 },
  WET: { offset: 0 },
  WEST: { offset: 60 },
  CET: { offset: 60 },
  CEST: { offset: 2 * 60 },
  EET: { offset: 2 * 60 },
  EEST: { offset: 3 * 60 },
  MSK: { offset: 3 * 60 },
  JST: { offset: 9 * 60 },
  KST: { offset: 9 * 60 },
  HKT: { offset: 8 * 60 },
  SGT: { offset: 8 * 60 },
  AWST: { offset: 8 * 60 },
  ACST: { offset: 9 * 60 + 30 },
  ACDT: { offset: 10 * 60 + 30 },
  AEST: { offset: 10 * 60 },
  AEDT: { offset: 11 * 60 },
  NZST: { offset: 12 * 60 },
  NZDT: { offset: 13 * 60 },
};

/** US zones by name: "9pm Eastern", "8 PM Pacific Time". */
const NAMED: Readonly<Record<string, Zone>> = {
  eastern: { place: "America/New_York" },
  central: { place: "America/Chicago" },
  mountain: { place: "America/Denver" },
  pacific: { place: "America/Los_Angeles" },
};

/**
 * A clock time and a zone. Groups: 1 hour, 2 minutes, 3 a/p, 4 the zone
 * (an abbreviation or a US zone's name), 5–7 an offset after UTC or GMT.
 * Not after a letter, digit, colon or dot, so `v1.8PM`-like runs and
 * `12:20:00 UTC`'s seconds don't start one.
 */
const TIME =
  /(?<![\p{L}\p{N}:.])(\d{1,2})(?::([0-5]\d))?(?:\s?([aApP])\.?[mM]\.?)?\s?([A-Z]{2,4}|[Ee]astern|[Cc]entral|[Mm]ountain|[Pp]acific)(?:([+\-−])(\d{1,2})(?::?([0-5]\d))?)?(?:\s+(?:[Ss]tandard|[Dd]aylight))?(?:\s+[Tt]ime)?(?![\p{L}\p{N}])/gu;

/** A time found in some words, and when it is. */
export interface FoundTime {
  /** Where it is in the words, `end` exclusive. */
  start: number;
  end: number;
  /** The moment it names, in milliseconds. */
  at: number;
  /** The day it falls on where it was written, as `year * 10000 + month * 100 + day`. */
  day: number;
  /** The clock time written, in minutes after midnight. */
  wall: number;
}

/**
 * Every time with a zone in `text`, placed on the day it was written
 * (`writtenAt`, milliseconds), in the order they appear.
 */
export function findTimes(text: string, writtenAt: number): FoundTime[] {
  if (!Number.isFinite(writtenAt) || !/\d/u.test(text)) return [];
  const found: FoundTime[] = [];
  for (const match of text.matchAll(TIME)) {
    const [whole, hourText, minuteText, half, zoneText, sign, offsetHours, offsetMinutes] = match;
    const named = !/^[A-Z]+$/u.test(zoneText ?? "");
    // A US zone's name followed by another name is something else:
    // "8pm Central European Time", "6pm Pacific Northwest".
    if (named && /^\s+\p{Lu}/u.test(text.slice((match.index ?? 0) + whole.length))) continue;
    let zone = named ? NAMED[(zoneText ?? "").toLowerCase()] : ZONES[zoneText ?? ""];
    if (zone === undefined) continue;
    if (sign !== undefined) {
      // An offset only after UTC or GMT: "UTC+2", "GMT-05:00".
      if (zoneText !== "UTC" && zoneText !== "GMT") continue;
      const size = Number(offsetHours) * 60 + Number(offsetMinutes ?? 0);
      if (Number(offsetHours) > 14) continue;
      zone = { offset: sign === "+" ? size : -size };
    }
    // A clock time says its minutes or its half of the day.
    if (minuteText === undefined && half === undefined) continue;
    let hour = Number(hourText);
    const minute = Number(minuteText ?? 0);
    if (half !== undefined) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (half.toLowerCase() === "p" ? 12 : 0);
    } else if (hour > 23) {
      continue;
    }
    const placed = place(zone, writtenAt, hour, minute);
    if (placed === null) continue;
    const start = match.index ?? 0;
    found.push({ start, end: start + whole.length, ...placed, wall: hour * 60 + minute });
  }
  return found;
}

/**
 * The moment `hour:minute` names in `zone`, on the day it is there at
 * `writtenAt`, and that day.
 */
function place(zone: Zone, writtenAt: number, hour: number, minute: number): { at: number; day: number } | null {
  if ("offset" in zone) {
    const there = new Date(writtenAt + zone.offset * 60_000);
    const wall = Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate(), hour, minute);
    return { at: wall - zone.offset * 60_000, day: dayNumber(there.getUTCFullYear(), there.getUTCMonth() + 1, there.getUTCDate()) };
  }
  const today = partsIn(zone.place, writtenAt);
  if (today === null) return null;
  const wall = Date.UTC(today.year, today.month - 1, today.day, hour, minute);
  // The place's offset at that wall time: guess with the offset at the wall
  // time read as UTC, then once more in case a clock change lies between.
  let at = wall - (offsetIn(zone.place, wall) ?? 0) * 60_000;
  at = wall - (offsetIn(zone.place, at) ?? 0) * 60_000;
  return { at, day: dayNumber(today.year, today.month, today.day) };
}

/**
 * What a found time is for the reader: "9:00 PM for you", with "the next
 * day" or "the day before" when it falls on another date than where it was
 * written, and "for you too" when the reader's clock already says it.
 *
 * `zone` and `locale` are the reader's; left out, they're this computer's.
 */
export function forYou(time: FoundTime, zone?: string, locale?: string): string {
  const clock = clockFormat(locale, zone).format(time.at);
  const here = partsIn(zone ?? localZone(), time.at);
  if (here === null) return `${clock} for you`;
  const shift = daysApart(time.day, dayNumber(here.year, here.month, here.day));
  if (shift === 0 && here.hour * 60 + here.minute === time.wall) return `${clock} for you too`;
  if (shift === 1) return `${clock} for you, the next day`;
  if (shift === -1) return `${clock} for you, the day before`;
  if (shift > 1) return `${clock} for you, ${shift} days later`;
  if (shift < -1) return `${clock} for you, ${-shift} days earlier`;
  return `${clock} for you`;
}

function dayNumber(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

function daysApart(from: number, to: number): number {
  const utc = (n: number) => Date.UTC(Math.floor(n / 10_000), (Math.floor(n / 100) % 100) - 1, n % 100);
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

function localZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Formatters are slow to build and these are asked on every draw of a
// message with a time in it, so each is built once (#170, #535).
const PARTS = new Map<string, Intl.DateTimeFormat | null>();
const CLOCKS = new Map<string, Intl.DateTimeFormat>();

function partsFormat(place: string): Intl.DateTimeFormat | null {
  let format = PARTS.get(place);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: place,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      // A place this engine's zone data doesn't know.
      format = null;
    }
    PARTS.set(place, format);
  }
  return format;
}

function clockFormat(locale: string | undefined, zone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${zone ?? ""}`;
  let format = CLOCKS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone });
    CLOCKS.set(key, format);
  }
  return format;
}

/** The wall clock in `place` at `at`. */
function partsIn(place: string, at: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const format = partsFormat(place);
  if (format === null || !Number.isFinite(at)) return null;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Minutes `place`'s clock is ahead of UTC at `at`. */
function offsetIn(place: string, at: number): number | null {
  const wall = partsIn(place, at);
  if (wall === null) return null;
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - (at - (((at % 1000) + 1000) % 1000))) / 60_000);
}
