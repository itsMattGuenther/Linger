/**
 * The divider labels are date arithmetic, and date arithmetic is the kind of
 * thing that looks right and is wrong at 2am, on a Sunday, or in March.
 *
 * Every date here is built with the local-time constructor, so the tests mean
 * the same thing in every timezone. Weekday names are compared against what the
 * machine's own locale produces rather than hard-coded English, so the suite
 * does not quietly depend on the runner being set to en-US.
 */
import { describe, expect, it, vi } from "vitest";

import { ageOpacity, clockTime, fullTime, hitTime, sessionLabel } from "./time";

/** Local-time helper: `at(2026, 8, 15, 9, 14)` is 15 August 2026, 9:14am. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function weekdayOf(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
}

describe("sessionLabel", () => {
  const now = at(2026, 8, 20, 14, 0); // Thursday afternoon

  it("names the parts of today", () => {
    expect(sessionLabel(at(2026, 8, 20, 9, 14), now)).toBe("this morning");
    expect(sessionLabel(at(2026, 8, 20, 13, 0), now)).toBe("this afternoon");
    expect(sessionLabel(at(2026, 8, 20, 18, 30), now)).toBe("this evening");
    expect(sessionLabel(at(2026, 8, 20, 22, 5), now)).toBe("tonight");
  });

  it("names the parts of yesterday", () => {
    expect(sessionLabel(at(2026, 8, 19, 9, 14), now)).toBe("yesterday morning");
    expect(sessionLabel(at(2026, 8, 19, 15, 0), now)).toBe("yesterday afternoon");
    expect(sessionLabel(at(2026, 8, 19, 19, 0), now)).toBe("yesterday evening");
    expect(sessionLabel(at(2026, 8, 19, 23, 30), now)).toBe("last night");
  });

  it("uses the weekday inside the past week", () => {
    const saturday = at(2026, 8, 15, 9, 14);
    expect(sessionLabel(saturday, now)).toBe(`${weekdayOf(saturday)} morning`);
    const sunday = at(2026, 8, 16, 21, 30);
    expect(sessionLabel(sunday, now)).toBe(`${weekdayOf(sunday)} night`);
  });

  it("hangs the small hours on the evening before", () => {
    // 2am Wednesday is what anyone would call late Tuesday night.
    const wednesday2am = at(2026, 8, 19, 2, 30);
    const tuesday = at(2026, 8, 18, 12, 0);
    expect(sessionLabel(wednesday2am, now)).toBe(`late ${weekdayOf(tuesday)} night`);
  });

  it("says 'late last night' when the evening before was yesterday", () => {
    // 1am today, read at 2pm today: the night that just ended was last night.
    expect(sessionLabel(at(2026, 8, 20, 1, 0), now)).toBe("late last night");
    // And read at 3am, before the sun is up, it is still last night.
    expect(sessionLabel(at(2026, 8, 20, 1, 0), at(2026, 8, 20, 3, 0))).toBe("late last night");
  });

  it("adds a date once the weekday stops locating anything", () => {
    const monthAgo = at(2026, 7, 18, 9, 0);
    const label = sessionLabel(monthAgo, now);
    expect(label.startsWith(`${weekdayOf(monthAgo)} morning, `)).toBe(true);
  });

  it("adds the year when it is not this year", () => {
    const lastYear = at(2025, 11, 3, 9, 0);
    expect(sessionLabel(lastYear, now)).toContain("2025");
  });

  it("counts calendar days, not 24-hour blocks", () => {
    // 11:30pm yesterday to 12:30am today is an hour apart and two days apart.
    expect(sessionLabel(at(2026, 8, 19, 23, 30), at(2026, 8, 20, 0, 30))).toBe("last night");
  });

  it("does not label a clock-skewed future message as days away", () => {
    const ahead = at(2026, 8, 21, 9, 0);
    expect(sessionLabel(ahead, now)).toBe("this morning");
  });
});

describe("clockTime", () => {
  it("uses the reader's locale for message timestamps", () => {
    const date = at(2026, 8, 20, 9, 14);
    expect(clockTime(date)).toBe(new Date(date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  });
});

describe("ageOpacity", () => {
  const now = at(2026, 8, 20, 14, 0);

  it("steps down 100 → 88 → 78 and stops", () => {
    expect(ageOpacity(now - 59 * 60 * 1000, now)).toBe(1);
    expect(ageOpacity(now - 2 * 60 * 60 * 1000, now)).toBe(0.88);
    expect(ageOpacity(now - 3 * 24 * 60 * 60 * 1000, now)).toBe(0.78);
    // The floor holds: a year old is no fainter than a week old.
    expect(ageOpacity(now - 365 * 24 * 60 * 60 * 1000, now)).toBe(0.78);
  });
});

describe("formatting a time", () => {
  // Building a date formatter is the slow part of formatting a date, and
  // every row formats its time on every render. They are built once, when the
  // module loads, and never per call (#170). `Date#toLocale*String` with
  // options builds one internally on every call, where a spy on the
  // constructor cannot see it, so those are watched too.
  it("reuses its formatters instead of building one per call", () => {
    const spies = [
      vi.spyOn(Intl, "DateTimeFormat"),
      vi.spyOn(Date.prototype, "toLocaleString"),
      vi.spyOn(Date.prototype, "toLocaleDateString"),
      vi.spyOn(Date.prototype, "toLocaleTimeString"),
    ];
    const at = Date.UTC(2026, 8, 24, 21, 5);
    for (let i = 0; i < 50; i += 1) {
      clockTime(at + i);
      fullTime(at + i);
      hitTime(at + i);
      sessionLabel(at + i, at + 9 * 86_400_000);
      sessionLabel(at + i, at + 400 * 86_400_000);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

