import { describe, expect, it } from "vitest";
import { type FoundTime, findTimes, forYou } from "./writtenTime";

/** Written on Wednesday 2026-10-07 at noon, Chicago (17:00 UTC), in summer time. */
const OCT = Date.UTC(2026, 9, 7, 17, 0);
/** Written on Wednesday 2026-01-14 at noon, Chicago (18:00 UTC), in winter time. */
const JAN = Date.UTC(2026, 0, 14, 18, 0);

const words = (text: string, found: FoundTime[]) => found.map((one) => text.slice(one.start, one.end));
const iso = (one: FoundTime | undefined) => (one ? new Date(one.at).toISOString() : "");

describe("findTimes (#584)", () => {
  it("finds a clock time with a zone, as the message of the day writes it", () => {
    const text = "We will be meeting on Friday, Oct 9 @ 8PM CDT to discuss faction choice.";
    const found = findTimes(text, OCT);
    expect(words(text, found)).toEqual(["8PM CDT"]);
    // 8 PM in Chicago in October is 01:00 UTC the next day.
    expect(iso(found[0])).toBe("2026-10-08T01:00:00.000Z");
  });

  it("reads the shapes people write", () => {
    const text = "20:00 UTC, 9pm Eastern, 8:30 p.m. PT, 7 PM Pacific Time, 6:15am JST, 14:00 UTC+2, 9 AM GMT-05:00, 5pm Central Standard Time";
    const found = findTimes(text, OCT);
    expect(words(text, found)).toEqual([
      "20:00 UTC",
      "9pm Eastern",
      "8:30 p.m. PT",
      "7 PM Pacific Time",
      "6:15am JST",
      "14:00 UTC+2",
      "9 AM GMT-05:00",
      "5pm Central Standard Time",
    ]);
    expect(found.map(iso)).toEqual([
      "2026-10-07T20:00:00.000Z",
      "2026-10-08T01:00:00.000Z",
      "2026-10-08T03:30:00.000Z",
      "2026-10-08T02:00:00.000Z",
      "2026-10-07T21:15:00.000Z",
      "2026-10-07T12:00:00.000Z",
      "2026-10-07T14:00:00.000Z",
      "2026-10-07T22:00:00.000Z",
    ]);
  });

  it("places the time on the day it was written, in summer or winter", () => {
    // Summer: Eastern is UTC-4. Winter: UTC-5. Read today, the written date decides.
    expect(iso(findTimes("8pm Eastern", OCT)[0])).toBe("2026-10-08T00:00:00.000Z");
    expect(iso(findTimes("8pm Eastern", JAN)[0])).toBe("2026-01-15T01:00:00.000Z");
    // EST in summer means the clock in New York, as nearly everybody who writes it does.
    expect(iso(findTimes("8PM EST", OCT)[0])).toBe("2026-10-08T00:00:00.000Z");
    // MST stays UTC-7 all year: Arizona keeps it.
    expect(iso(findTimes("8PM MST", OCT)[0])).toBe("2026-10-08T03:00:00.000Z");
    // A fixed offset: the day is the one it was there when written.
    expect(iso(findTimes("9:00 AEST", OCT)[0])).toBe("2026-10-07T23:00:00.000Z");
  });

  it("leaves alone what might be something else", () => {
    for (const text of [
      "at 8 PT", // a bare number
      "8PM CST", // CST is China's too
      "8PM IST", // India, Ireland, Israel
      "8PM BST", // British summer, Bangladesh
      "8pm cdt", // lowercase letters are words, not a zone
      "Room 12 UTC",
      "v1.8PM CDT",
      "13PM UTC",
      "25:00 UTC",
      "8pm Central European Time",
      "6pm Pacific Northwest",
      "UTC",
      "8PM CDTX",
    ]) {
      expect(findTimes(text, OCT), text).toEqual([]);
    }
  });

  it("finds nothing in words without digits, or with no date to place them on", () => {
    expect(findTimes("Friday evening Central", OCT)).toEqual([]);
    expect(findTimes("8PM CDT", Number.NaN)).toEqual([]);
  });
});

describe("forYou (#584)", () => {
  const meeting = findTimes("8PM CDT", OCT)[0];
  if (meeting === undefined) throw new Error("expected a time");

  it("says the time in the reader's clock", () => {
    expect(forYou(meeting, "America/New_York", "en-US")).toBe("9:00 PM for you");
    expect(forYou(meeting, "America/Los_Angeles", "en-US")).toBe("6:00 PM for you");
  });

  it("names the day when it crosses midnight", () => {
    expect(forYou(meeting, "Europe/Berlin", "en-US")).toBe("3:00 AM for you, the next day");
    const morning = findTimes("9:00 AM JST", OCT)[0];
    if (morning === undefined) throw new Error("expected a time");
    expect(forYou(morning, "America/Chicago", "en-US")).toBe("7:00 PM for you, the day before");
  });

  it("says so when the reader's clock already reads it", () => {
    expect(forYou(meeting, "America/Chicago", "en-US")).toBe("8:00 PM for you too");
  });

  it("writes the clock the reader's way", () => {
    // A 24-hour clock, with or without the leading zero as the engine has it.
    expect(forYou(meeting, "Europe/London", "en-GB")).toMatch(/^0?2:00 for you, the next day$/);
  });
});
