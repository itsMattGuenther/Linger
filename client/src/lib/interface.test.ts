import { describe, expect, it } from "vitest";
import { clampPanel, validScale } from "./interface";
import { frameLayout } from "./layout";

describe("private interface preferences", () => {
  it("accepts only usable scale steps", () => {
    for (const value of [null, undefined, "200", 0, -1, 103, Infinity, NaN])
      expect(validScale(value)).toBe(100);
    for (const value of [100, 110, 125, 150, 175, 200])
      expect(validScale(value)).toBe(value);
  });
  it("bounds panel widths and recovers corrupt saved values", () => {
    expect(clampPanel("rail", 2)).toBe(200);
    expect(clampPanel("rail", 900)).toBe(360);
    expect(clampPanel("roster", 2)).toBe(232);
    expect(clampPanel("roster", Infinity)).toBe(264);
    expect(clampPanel("rail", NaN)).toBe(232);
  });
  it("fits both panels without spending the conversation's minimum width", () => {
    for (const width of [960, 1000, 1100, 1280, 1920]) {
      const layout = frameLayout(width, 100, 360, 400);
      expect(layout.rail).toBeGreaterThanOrEqual(200);
      expect(layout.roster).toBeGreaterThanOrEqual(232);
      expect(width - layout.rail - layout.roster - 8).toBeGreaterThanOrEqual(
        420,
      );
    }
  });
  it("reflows for the reader's scale, not just the physical window", () => {
    expect(frameLayout(1100, 100, 232, 264).narrow).toBe(false);
    expect(frameLayout(1100, 150, 232, 264).narrow).toBe(true);
    expect(frameLayout(760, 200, 232, 264).stacked).toBe(true);
  });
});
