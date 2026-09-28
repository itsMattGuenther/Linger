import { describe, expect, it } from "vitest";

import { knockLimitLine } from "./knock";

const MINUTE = 60_000;

describe("knockLimitLine (#268)", () => {
  it("says when the next knock goes", () => {
    expect(knockLimitLine(20 * MINUTE)).toBe("Three knocks this hour. You can knock again in 20 minutes.");
  });

  it("rounds minutes up, so the time given is never early", () => {
    expect(knockLimitLine(19 * MINUTE + 10_000)).toBe("Three knocks this hour. You can knock again in 20 minutes.");
    expect(knockLimitLine(MINUTE + 1)).toBe("Three knocks this hour. You can knock again in 2 minutes.");
    expect(knockLimitLine(59 * MINUTE)).toBe("Three knocks this hour. You can knock again in 59 minutes.");
  });

  it("says a minute for a minute or less", () => {
    for (const ms of [0, 1, 45_000, MINUTE]) {
      expect(knockLimitLine(ms)).toBe("Three knocks this hour. You can knock again in a minute.");
    }
  });

  it("says an hour for sixty minutes, the most it can be", () => {
    expect(knockLimitLine(60 * MINUTE)).toBe("Three knocks this hour. You can knock again in an hour.");
    expect(knockLimitLine(59 * MINUTE + 1)).toBe("Three knocks this hour. You can knock again in an hour.");
  });

  it("says later when the refusal gives no time", () => {
    expect(knockLimitLine(null)).toBe("Three knocks this hour. You can knock again later.");
    expect(knockLimitLine(Number.NaN)).toBe("Three knocks this hour. You can knock again later.");
  });
});
