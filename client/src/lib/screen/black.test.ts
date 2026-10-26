import { describe, expect, it } from "vitest";
import { BLACK_FOR_MS, BLACK_LEVEL, BlackWatch, LOOK_HEIGHT, LOOK_WIDTH, looksBlack } from "./black";

const PIXELS = LOOK_WIDTH * LOOK_HEIGHT;

/** The copy as RGBA, every pixel `rgb`, with `lit` pixels white at the start. */
function rgba(rgb: [number, number, number], lit = 0): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(PIXELS * 4);
  for (let at = 0; at < PIXELS; at += 1) {
    const [r, g, b] = at < lit ? [255, 255, 255] : rgb;
    pixels.set([r, g, b, 255], at * 4);
  }
  return pixels;
}

describe("looksBlack", () => {
  it("a black picture is black, as black and as a capture's 16", () => {
    expect(looksBlack(rgba([0, 0, 0]), 4)).toBe(true);
    expect(looksBlack(rgba([16, 16, 16]), 4)).toBe(true);
    expect(looksBlack(new Uint8Array(PIXELS).fill(16), 1)).toBe(true);
  });

  it("a dark slide isn't: navy, or black with a line of text on it", () => {
    expect(looksBlack(rgba([10, 20, 60]), 4)).toBe(false);
    expect(looksBlack(rgba([BLACK_LEVEL + 1, 0, 0]), 4)).toBe(false);
    // A title across a black slide, at the copy's size: a few hundred pixels.
    expect(looksBlack(rgba([0, 0, 0], 300), 4)).toBe(false);
    const gray = new Uint8Array(PIXELS).fill(0);
    gray.fill(200, 0, 300);
    expect(looksBlack(gray, 1)).toBe(false);
  });

  it("a pointer over a black picture leaves it black", () => {
    // A pointer at 1080p is about 20 by 32, a handful of pixels in the copy.
    expect(looksBlack(rgba([0, 0, 0], 8), 4)).toBe(true);
    expect(looksBlack(rgba([0, 0, 0], Math.floor(PIXELS / 1000)), 4)).toBe(true);
    expect(looksBlack(rgba([0, 0, 0], Math.floor(PIXELS / 1000) + 1), 4)).toBe(false);
  });

  it("alpha isn't counted, and no picture isn't black", () => {
    const clear = rgba([0, 0, 0]);
    for (let at = 3; at < clear.length; at += 4) clear[at] = 0;
    expect(looksBlack(clear, 4)).toBe(true);
    expect(looksBlack(new Uint8ClampedArray(0), 4)).toBe(false);
  });
});

describe("BlackWatch", () => {
  it("says so once, when it has been black for long enough", () => {
    const watch = new BlackWatch();
    const said = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000].map((at) => watch.look(at, true));
    expect(BLACK_FOR_MS).toBe(5_000);
    expect(said).toEqual([false, false, false, false, false, true, false, false]);
  });

  it("anything not black starts it over: a cut to black between slides isn't said", () => {
    const watch = new BlackWatch();
    expect(watch.look(0, true)).toBe(false);
    expect(watch.look(4_000, true)).toBe(false);
    expect(watch.look(4_500, false)).toBe(false);
    expect(watch.look(5_000, true)).toBe(false);
    expect(watch.look(9_000, true)).toBe(false);
    expect(watch.look(10_000, true)).toBe(true);
  });

  it("said once, it isn't said again in that share", () => {
    const watch = new BlackWatch();
    watch.look(0, true);
    expect(watch.look(5_000, true)).toBe(true);
    watch.look(6_000, false);
    watch.look(7_000, true);
    expect(watch.look(20_000, true)).toBe(false);
  });
});
