import { describe, expect, it } from "vitest";
import { validScale } from "./interface";

describe("private interface preferences", () => {
  it("accepts only usable scale steps", () => {
    for (const value of [null, undefined, "200", 0, -1, 103, Infinity, NaN])
      expect(validScale(value)).toBe(100);
    for (const value of [100, 110, 125, 150, 175, 200])
      expect(validScale(value)).toBe(value);
  });
});
