import { describe, expect, it } from "vitest";

import { isEvening } from "./theme";

/** A local-time moment, built from the parts the function actually reads. */
function at(hour: number): Date {
  return new Date(2026, 7, 27, hour, 30, 0);
}

describe("isEvening", () => {
  it("is warm from the evening through to the morning", () => {
    expect(isEvening(at(19))).toBe(true);
    expect(isEvening(at(22))).toBe(true);
    expect(isEvening(at(0))).toBe(true);
    expect(isEvening(at(3))).toBe(true);
    expect(isEvening(at(6))).toBe(true);
  });

  it("is cool through the working day", () => {
    expect(isEvening(at(7))).toBe(false);
    expect(isEvening(at(12))).toBe(false);
    expect(isEvening(at(18))).toBe(false);
  });

  it("turns exactly on the hour, both ends", () => {
    expect(isEvening(new Date(2026, 7, 27, 18, 59, 59))).toBe(false);
    expect(isEvening(new Date(2026, 7, 27, 19, 0, 0))).toBe(true);
    expect(isEvening(new Date(2026, 7, 27, 6, 59, 59))).toBe(true);
    expect(isEvening(new Date(2026, 7, 27, 7, 0, 0))).toBe(false);
  });
});
