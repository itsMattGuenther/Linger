import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeScrollNow } from "./scrollWatch";

/** A conversation's scroller: where it's scrolled, and its scroll events, sent by hand. */
function scroller() {
  const heard = new Set<() => void>();
  return {
    scrollTop: 0,
    addEventListener: (_type: string, handler: () => void) => heard.add(handler),
    removeEventListener: (_type: string, handler: () => void) => heard.delete(handler),
    /** Scrolled by somebody, with the event that says so. */
    scrolledTo(top: number) {
      this.scrollTop = top;
      for (const handler of heard) handler();
    },
  };
}

/** What the virtualizer's watch reads off the virtualizer: its scroller, its window's clock, and its options. */
function virtualizerOver(element: ReturnType<typeof scroller>) {
  const fake = { scrollElement: element, targetWindow: globalThis, options: { horizontal: false, isScrollingResetDelay: 150 } };
  return fake as unknown as Virtualizer<HTMLDivElement, Element>;
}

describe("observeScrollNow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says each scroll as its event saw it", () => {
    const element = scroller();
    const said: [number, boolean][] = [];
    observeScrollNow(virtualizerOver(element), (offset, isScrolling) => said.push([offset, isScrolling]));
    element.scrolledTo(1100);
    element.scrolledTo(900);
    vi.advanceTimersByTime(150);
    expect(said).toEqual([
      [1100, true],
      [900, true],
      [900, false],
    ]);
  });

  it("when scrolling stops, says where the conversation is then, not where its last scroll event saw it (#716)", () => {
    const element = scroller();
    const said: [number, boolean][] = [];
    observeScrollNow(virtualizerOver(element), (offset, isScrolling) => said.push([offset, isScrolling]));
    element.scrolledTo(1100);
    // A page of older history went in above, and the virtualizer moved the
    // reader down by its height. On a busy computer, the stop comes before
    // that move's own scroll event.
    element.scrollTop = 3500;
    vi.advanceTimersByTime(150);
    expect(said).toEqual([
      [1100, true],
      [3500, false],
    ]);
  });

  it("stops listening when the virtualizer lets go", () => {
    const element = scroller();
    const said: [number, boolean][] = [];
    const stop = observeScrollNow(virtualizerOver(element), (offset, isScrolling) => said.push([offset, isScrolling]));
    element.scrolledTo(1100);
    stop?.();
    element.scrolledTo(900);
    vi.advanceTimersByTime(150);
    expect(said).toEqual([[1100, true]]);
  });
});
