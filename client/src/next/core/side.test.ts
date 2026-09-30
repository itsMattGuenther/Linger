import { describe, expect, it } from "vitest";
import { FOLDED, folding, layoutOf, LIST_MAX, LIST_MIN, LIST_WIDTH, listWidth, loadSide, PANE_MIN, PANE_WIDTH, paneWidth, saveSide, unfolding } from "./side";

function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void; held: Map<string, string> } {
  const held = new Map<string, string>();
  return { held, getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
}

describe("what's kept of the side", () => {
  it("starts folded, at the designed sizes", () => {
    expect(loadSide(memory())).toEqual({ unfolded: false, list: LIST_WIDTH, pane: PANE_WIDTH });
    expect(loadSide(null)).toEqual(FOLDED);
  });

  it("comes back as it was left", () => {
    const store = memory();
    saveSide(store, { unfolded: true, list: 360, pane: 900 });
    expect(loadSide(store)).toEqual({ unfolded: true, list: 360, pane: 900 });
  });

  it("reads anything odd as the designed sizes, and a list or pane out of range as the nearest in range", () => {
    const store = memory();
    store.setItem("linger.next.side", "{not json");
    expect(loadSide(store)).toEqual(FOLDED);
    store.setItem("linger.next.side", JSON.stringify({ unfolded: "yes", list: "wide", pane: null }));
    expect(loadSide(store)).toEqual(FOLDED);
    store.setItem("linger.next.side", JSON.stringify({ unfolded: true, list: 2000, pane: 10 }));
    expect(loadSide(store)).toEqual({ unfolded: true, list: LIST_MAX, pane: PANE_MIN });
  });

  it("keeps a list between its narrowest and its widest, and a pane no narrower than it can be", () => {
    expect(listWidth(120)).toBe(LIST_MIN);
    expect(listWidth(1500)).toBe(LIST_MAX);
    expect(listWidth(371.4)).toBe(371);
    expect(paneWidth(200)).toBe(PANE_MIN);
    expect(paneWidth(1200)).toBe(1200);
  });

  it("survives storage that refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
    };
    expect(loadSide(refusing)).toEqual(FOLDED);
    expect(() => saveSide(refusing, FOLDED)).not.toThrow();
  });
});

describe("the list and a conversation in one window", () => {
  it("sit side by side when both fit, and the conversation takes the window when they don't", () => {
    expect(layoutOf(LIST_WIDTH + PANE_MIN, LIST_WIDTH)).toBe("beside");
    expect(layoutOf(LIST_WIDTH + PANE_MIN - 1, LIST_WIDTH)).toBe("over");
    // A narrow tile, as a tiling desktop may leave the window.
    expect(layoutOf(357, LIST_WIDTH)).toBe("over");
  });
});

describe("unfolding", () => {
  const side = { unfolded: false, list: 340, pane: 780 };
  const screen = { x: 0, width: 1920 };

  it("grows the window to the right by the pane's width", () => {
    expect(unfolding({ x: 100, width: 340 }, screen, side, 1)).toEqual({ width: 1120, x: null });
  });

  it("grows it leftwards where the screen ends, never past the screen's left edge", () => {
    expect(unfolding({ x: 1500, width: 340 }, screen, side, 1)).toEqual({ width: 1120, x: 800 });
    // A screen narrower than the whole: as wide as the screen, from its edge.
    expect(unfolding({ x: 200, width: 340 }, { x: 0, width: 1000 }, side, 1)).toEqual({ width: 1000, x: 0 });
  });

  it("measures on the screen the window is on, wherever that screen is", () => {
    expect(unfolding({ x: 3500, width: 340 }, { x: 1920, width: 1920 }, side, 1)).toEqual({ width: 1120, x: 2720 });
  });

  it("leaves a window alone that's wide enough already: maximized, or a wide tile", () => {
    expect(unfolding({ x: 0, width: 1920 }, screen, side, 1)).toBeNull();
    expect(unfolding({ x: 0, width: 340 + PANE_MIN }, screen, side, 1)).toBeNull();
  });

  it("counts interface size: the page's pixels are bigger at 150%", () => {
    expect(unfolding({ x: 0, width: 510 }, screen, side, 1.5)).toEqual({ width: 1680, x: null });
    // 340 + 420 at 150% is 1140 of the desktop's pixels: wide enough.
    expect(unfolding({ x: 0, width: 1140 }, screen, side, 1.5)).toBeNull();
  });

  it("with no screen to measure, just grows", () => {
    expect(unfolding({ x: 5000, width: 340 }, null, side, 1)).toEqual({ width: 1120, x: null });
  });
});

describe("folding", () => {
  it("goes back to the list's width, at the interface size", () => {
    expect(folding({ unfolded: true, list: 340, pane: 780 }, 1)).toBe(340);
    expect(folding({ unfolded: true, list: 360, pane: 780 }, 1.25)).toBe(450);
  });
});
