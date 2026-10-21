import { describe, expect, it } from "vitest";
import type { HoldTimers } from "./hold";
import { DOUBLE_TAP_MS, DOUBLE_TAP_ZOOM, type Layout, MAX_ZOOM, startZoom, type View } from "./zoom";

/** A clock that only moves when the test says. */
function clock() {
  let now = 0;
  let next = 1;
  const waiting = new Map<number, { at: number; run: () => void }>();
  const timers: HoldTimers = {
    set: (run, ms) => {
      const id = next++;
      waiting.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => {
      waiting.delete(id);
    },
  };
  const pass = (ms: number) => {
    now += ms;
    for (const [id, one] of [...waiting]) {
      if (one.at > now) continue;
      waiting.delete(id);
      one.run();
    }
  };
  return { timers, pass, waiting: () => waiting.size };
}

/** A phone's screen, with a 1.6:1 picture across it 20 in from each side. */
const LAYOUT: Layout = {
  box: { left: 20, top: 100 },
  picture: { left: 20, top: 100, width: 360, height: 225 },
  screen: { width: 400, height: 800 },
};

function viewer(layout: Layout | null = LAYOUT) {
  const time = clock();
  const drawn: { view: View; glide: boolean }[] = [];
  let taps = 0;
  const zoom = startZoom(
    () => layout,
    (view, glide) => drawn.push({ view, glide }),
    () => (taps += 1),
    time.timers,
  );
  const tap = (x: number, y: number, pointer = 1) => {
    zoom.down(pointer, x, y);
    zoom.up(pointer, x, y);
  };
  /** Two fingers 100 apart across `at`, moved to `apart` apart and left down. */
  const pinch = (at: { x: number; y: number }, apart: number) => {
    zoom.down(1, at.x - 50, at.y);
    zoom.down(2, at.x + 50, at.y);
    zoom.move(1, at.x - apart / 2, at.y);
    zoom.move(2, at.x + apart / 2, at.y);
  };
  const lift = () => {
    zoom.up(1, 0, 0);
    zoom.up(2, 0, 0);
  };
  const last = () => drawn.at(-1);
  return { zoom, tap, pinch, lift, last, drawn, pass: time.pass, waiting: time.waiting, taps: () => taps };
}

/** Where a point of the unzoomed page is drawn, along x, once zoomed. */
const drawnAt = (view: View, x: number) => LAYOUT.box.left + view.x + view.scale * (x - LAYOUT.box.left);

describe("zooming a picture with your fingers (#689)", () => {
  it("two fingers spread apart zoom in around the point between them", () => {
    const { pinch, last } = viewer();
    pinch({ x: 200, y: 200 }, 200);
    const view = last()?.view;
    expect(view?.scale).toBeCloseTo(2);
    // What was under the fingers is still under them.
    expect(view && drawnAt(view, 200)).toBeCloseTo(200);
    expect(last()?.glide).toBe(false);
  });

  it("a picture that still fits down the screen stays centered down it", () => {
    const { pinch, last } = viewer();
    pinch({ x: 200, y: 140 }, 200);
    const view = last()?.view;
    if (!view) throw new Error("nothing drawn");
    const top = LAYOUT.box.top + view.y + view.scale * (LAYOUT.picture.top - LAYOUT.box.top);
    expect(top + (view.scale * LAYOUT.picture.height) / 2).toBeCloseTo(LAYOUT.picture.top + LAYOUT.picture.height / 2);
  });

  it("never gets smaller than it opened, nor bigger than four times that", () => {
    const { pinch, lift, last } = viewer();
    pinch({ x: 200, y: 200 }, 20);
    expect(last()?.view.scale).toBe(1);
    lift();
    pinch({ x: 200, y: 200 }, 2000);
    expect(last()?.view.scale).toBe(MAX_ZOOM);
  });

  it("one finger drags a zoomed picture, but leaves no gap at its edges", () => {
    const { zoom, pinch, lift, last } = viewer();
    pinch({ x: 200, y: 200 }, 200);
    lift();
    const before = last()?.view;
    zoom.down(3, 200, 300);
    zoom.move(3, 230, 300);
    expect(last()?.view.x).toBeCloseTo((before?.x ?? 0) + 30);
    zoom.move(3, 2000, 300);
    const view = last()?.view;
    // Its left edge stops at the screen's.
    expect(view && drawnAt(view, LAYOUT.picture.left)).toBeCloseTo(0);
    zoom.move(3, -2000, 300);
    const other = last()?.view;
    expect(other && drawnAt(other, LAYOUT.picture.left + LAYOUT.picture.width)).toBeCloseTo(LAYOUT.screen.width);
    zoom.up(3, -2000, 300);
  });

  it("one finger on a picture that isn't zoomed moves nothing, and isn't a tap", () => {
    const { zoom, drawn, pass, taps } = viewer();
    zoom.down(1, 200, 300);
    zoom.move(1, 260, 340);
    zoom.up(1, 260, 340);
    pass(DOUBLE_TAP_MS * 2);
    expect(drawn).toEqual([]);
    expect(taps()).toBe(0);
  });

  it("a tap closes the viewer once it's clear it wasn't the first of two", () => {
    const { tap, pass, taps, waiting } = viewer();
    tap(200, 300);
    pass(DOUBLE_TAP_MS - 1);
    expect(taps()).toBe(0);
    pass(1);
    expect(taps()).toBe(1);
    expect(waiting()).toBe(0);
  });

  it("a double tap zooms in on where it lands, the next zooms back out, and neither closes", () => {
    const { tap, pass, last, taps } = viewer();
    tap(100, 200);
    pass(120);
    tap(108, 206);
    expect(last()?.glide).toBe(true);
    const view = last()?.view;
    expect(view?.scale).toBe(DOUBLE_TAP_ZOOM);
    expect(view && drawnAt(view, 108)).toBeCloseTo(108);
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);

    tap(150, 260);
    pass(120);
    tap(150, 260);
    expect(last()).toEqual({ view: { scale: 1, x: 0, y: 0 }, glide: true });
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);
  });

  it("a second tap whose finger lifts late is still the second of two", () => {
    const { zoom, tap, pass, last, taps } = viewer();
    tap(100, 200);
    pass(DOUBLE_TAP_MS - 50);
    zoom.down(1, 100, 200);
    pass(100);
    zoom.up(1, 100, 200);
    expect(last()?.view.scale).toBe(DOUBLE_TAP_ZOOM);
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);
  });

  it("a tap while the picture is zoomed closes nothing, so looking around doesn't lose your place", () => {
    const { pinch, lift, tap, pass, taps } = viewer();
    pinch({ x: 200, y: 200 }, 200);
    lift();
    tap(200, 300);
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);
  });

  it("two taps far apart aren't a double tap", () => {
    const { tap, pass, drawn, taps } = viewer();
    tap(60, 200);
    pass(100);
    tap(340, 600);
    pass(DOUBLE_TAP_MS);
    expect(drawn).toEqual([]);
    expect(taps()).toBe(1);
  });

  it("a pinch is no tap, and the finger left down drags on from where it ended", () => {
    const { zoom, pinch, last, pass, taps } = viewer();
    pinch({ x: 200, y: 200 }, 200);
    const pinchedTo = last()?.view;
    zoom.up(2, 300, 200);
    zoom.move(1, 120, 200);
    expect(last()?.view.scale).toBeCloseTo(2);
    expect(last()?.view.x).toBeCloseTo((pinchedTo?.x ?? 0) + 20);
    zoom.up(1, 120, 200);
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);
  });

  it("a pinch let go of about where it began goes back to how the picture opened, and a tap closes again", () => {
    const { pinch, lift, tap, pass, last, taps } = viewer();
    pinch({ x: 200, y: 200 }, 103);
    expect(last()?.view.scale).toBeCloseTo(1.03);
    lift();
    expect(last()).toEqual({ view: { scale: 1, x: 0, y: 0 }, glide: true });
    tap(200, 300);
    pass(DOUBLE_TAP_MS);
    expect(taps()).toBe(1);
  });

  it("a tap and then a finger down that moves away is no tap at all", () => {
    const { zoom, tap, pass, taps } = viewer();
    tap(200, 300);
    pass(100);
    zoom.down(1, 200, 300);
    zoom.move(1, 200, 360);
    pass(DOUBLE_TAP_MS);
    zoom.up(1, 200, 360);
    pass(DOUBLE_TAP_MS);
    expect(taps()).toBe(0);
  });

  it("the browser taking a finger ends it, as no tap", () => {
    const { zoom, pass, taps } = viewer();
    zoom.down(1, 200, 300);
    zoom.cancel(1);
    zoom.up(1, 200, 300);
    pass(DOUBLE_TAP_MS * 2);
    expect(taps()).toBe(0);
  });

  it("with no picture to zoom, fingers zoom nothing but a tap still closes", () => {
    const { pinch, lift, tap, pass, drawn, taps } = viewer(null);
    pinch({ x: 200, y: 200 }, 200);
    lift();
    tap(200, 300);
    pass(100);
    tap(200, 300);
    expect(drawn).toEqual([]);
    tap(60, 700);
    pass(DOUBLE_TAP_MS);
    expect(taps()).toBe(1);
  });

  it("reset puts the picture back at once, and stop leaves no timer behind", () => {
    const { zoom, pinch, lift, tap, last, waiting, pass, taps } = viewer();
    pinch({ x: 200, y: 200 }, 200);
    lift();
    zoom.reset();
    expect(last()).toEqual({ view: { scale: 1, x: 0, y: 0 }, glide: false });
    tap(200, 300);
    expect(waiting()).toBe(1);
    zoom.stop();
    expect(waiting()).toBe(0);
    pass(DOUBLE_TAP_MS);
    expect(taps()).toBe(0);
  });
});
