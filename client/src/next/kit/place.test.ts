import { describe, expect, it } from "vitest";
import { EDGE, GAP, placeBeside } from "./place";

// One rule for where a menu or a list floats (lessons L-06, L-11).
const view = { width: 800, height: 600 };
const size = { width: 200, height: 150 };

describe("where something floats beside what opened it", () => {
  it("goes below, lined up with the anchor's start or end edge", () => {
    const anchor = { top: 100, left: 300, right: 340, bottom: 124 };
    expect(placeBeside(anchor, size, "start", view)).toEqual({ top: 124 + GAP, left: 300, room: 600 - EDGE - 124 - GAP });
    expect(placeBeside(anchor, size, "end", view).left).toBe(340 - 200);
  });

  it("goes above when there's no room below, like a list over the message box", () => {
    const box = { top: 540, left: 10, right: 790, bottom: 580 };
    const at = placeBeside(box, size, "start", view);
    expect(at.top).toBe(540 - GAP - 150);
    expect(at.top + size.height).toBeLessThanOrEqual(box.top);
    expect(at.left).toBe(EDGE + 2);
  });

  it("with no room either way, takes the side with more, and says how much there is", () => {
    const tall = { width: 200, height: 700 };
    const high = placeBeside({ top: 100, left: 10, right: 50, bottom: 120 }, tall, "start", view);
    expect(high.top).toBe(120 + GAP);
    expect(high.room).toBe(600 - EDGE - 120 - GAP);
    const low = placeBeside({ top: 500, left: 10, right: 50, bottom: 520 }, tall, "start", view);
    expect(low.room).toBe(500 - GAP - EDGE);
    expect(low.top).toBe(EDGE);
  });

  it("never leaves the window sideways", () => {
    expect(placeBeside({ top: 10, left: 700, right: 760, bottom: 30 }, size, "start", view).left).toBe(800 - EDGE - 200);
    expect(placeBeside({ top: 10, left: 0, right: 20, bottom: 30 }, size, "end", view).left).toBe(EDGE);
  });
});
