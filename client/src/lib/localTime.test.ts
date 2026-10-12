import { describe, expect, it } from "vitest";
import { LOCAL_TIME_NEEDS_UPDATE, localTimeProblem, timeFor, zoneToMove } from "./localTime";

describe("timeFor (#604)", () => {
  // Saturday 2026-10-10, 03:12 in Chicago (CDT, UTC−5): 08:12 UTC.
  const now = Date.UTC(2026, 9, 10, 8, 12);

  it("says their clock and their name", () => {
    expect(timeFor("America/Chicago", "Jules", now, "America/Chicago", "en-US")).toBe("3:12 AM for Jules");
    expect(timeFor("Europe/Lisbon", "Jules", now, "Europe/Lisbon", "en-US")).toBe("9:12 AM for Jules");
  });

  it("says when their day is ahead of the reader's, across midnight", () => {
    // 1:12 AM Saturday in Chicago is still 11:12 PM Friday in Los Angeles.
    const early = Date.UTC(2026, 9, 10, 6, 12);
    expect(timeFor("America/Chicago", "Jules", early, "America/Los_Angeles", "en-US")).toBe("1:12 AM for Jules, the next day");
    // Two hours later both are on Saturday.
    expect(timeFor("America/Chicago", "Jules", now, "America/Los_Angeles", "en-US")).toBe("3:12 AM for Jules");
  });

  it("says when their day is behind the reader's", () => {
    // 11:30 PM Friday in Los Angeles is already Saturday in Berlin.
    const late = Date.UTC(2026, 9, 10, 6, 30);
    expect(timeFor("America/Los_Angeles", "Sam", late, "Europe/Berlin", "en-US")).toBe("11:30 PM for Sam, the day before");
  });

  it("is the same day on both sides of the date line only when it really is", () => {
    // Noon UTC: 1:00 AM the next day in Kiritimati (UTC+14), 2:00 AM the same day in Pago Pago (UTC−11).
    const noon = Date.UTC(2026, 9, 10, 12, 0);
    expect(timeFor("Pacific/Kiritimati", "Ana", noon, "UTC", "en-US")).toBe("2:00 AM for Ana, the next day");
    expect(timeFor("Pacific/Pago_Pago", "Ana", noon, "UTC", "en-US")).toBe("1:00 AM for Ana");
  });

  it("says nothing for a zone this engine doesn't know", () => {
    expect(timeFor("Mars/Olympus_Mons", "Jules", now, "UTC", "en-US")).toBeNull();
  });
});

describe("zoneToMove (#604)", () => {
  it("moves a shown clock to where this computer is, once", () => {
    expect(zoneToMove("America/Chicago", "Europe/Lisbon", undefined)).toBe("Europe/Lisbon");
    expect(zoneToMove("America/Chicago", "Europe/Lisbon", "Europe/Lisbon")).toBeNull();
    // Asked for somewhere else before, and the computer moved again.
    expect(zoneToMove("America/Chicago", "Asia/Tokyo", "Europe/Lisbon")).toBe("Asia/Tokyo");
  });

  it("leaves it alone when it's off, already here, or this computer won't say", () => {
    expect(zoneToMove(undefined, "Europe/Lisbon", undefined)).toBeNull();
    expect(zoneToMove(null, "Europe/Lisbon", undefined)).toBeNull();
    expect(zoneToMove("Europe/Lisbon", "Europe/Lisbon", undefined)).toBeNull();
    expect(zoneToMove("America/Chicago", null, undefined)).toBeNull();
  });
});

describe("localTimeProblem (#640)", () => {
  it("says the server needs updating when it answers turning it on without a zone", () => {
    expect(localTimeProblem("America/Chicago", {})).toBe("This server needs updating before it can show your time.");
    expect(localTimeProblem("America/Chicago", { time_zone: "" })).toBe(LOCAL_TIME_NEEDS_UPDATE);
  });

  it("says nothing when the zone was kept, or when it was being turned off", () => {
    expect(localTimeProblem("America/Chicago", { time_zone: "America/Chicago" })).toBeNull();
    expect(localTimeProblem("", {})).toBeNull();
  });
});
