/**
 * Zooming a picture with your fingers, in the viewer a photo opens in. The
 * phone's page never zooms (#689, next.html's viewport), so the picture
 * zooms itself, as a phone's own photo viewer does: two fingers pinch it
 * bigger or smaller around the point between them, one finger drags it
 * about once it's bigger than the screen, and a double tap zooms in on
 * where it lands, or back out.
 *
 * A single tap is still what closes the viewer, but only once it's clear it
 * wasn't the first of two (`DOUBLE_TAP_MS`), and only while the picture
 * isn't zoomed, so a tap while looking around doesn't lose your place. A
 * finger that moves isn't a tap at all.
 *
 * The picture never gets smaller than it opened, nor bigger than
 * `MAX_ZOOM` times that. Bigger than the screen one way, it can't leave a
 * gap at either edge that way; smaller, it stays centered where it opened.
 *
 * No DOM here, as in hold.ts: the caller hands in the fingers, where the
 * picture sits and a clock, and draws what it's given (`zoom.test.ts`).
 */
import { HOLD_SLOP_PX, type HoldTimers, PAGE_TIMERS } from "./hold";

/** The most a picture zooms: four times the size it opened at. */
export const MAX_ZOOM = 4;

/** How far a double tap zooms in. */
export const DOUBLE_TAP_ZOOM = 2.5;

/** How long after a tap a second one makes it a double tap, and so how long a tap waits to close. */
export const DOUBLE_TAP_MS = 300;

/** How far apart two taps may land and still be a double tap, in CSS pixels. */
export const DOUBLE_TAP_SLOP_PX = 40;

/** A pinch let go of this close to the size it opened at goes back to it, so a tap closes again. */
const SNAP_ZOOM = 1.05;

/**
 * How the picture is drawn: `scale` times its size, moved by (`x`, `y`)
 * CSS pixels, around its element's top-left corner (`transform-origin: 0 0`).
 */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const UNZOOMED: View = { scale: 1, x: 0, y: 0 };

/** Where the picture sits when it isn't zoomed, in the page's CSS pixels. */
export interface Layout {
  /** Its element's top-left corner, what it zooms around. */
  box: { left: number; top: number };
  /** The picture drawn inside that element, which can be smaller than it (`object-fit: contain`). */
  picture: { left: number; top: number; width: number; height: number };
  screen: { width: number; height: number };
}

interface Point {
  x: number;
  y: number;
}

/**
 * Along one side: how far to move the picture, now `scale` times bigger,
 * so it shows no gap at an edge it's longer than, or stays centered where
 * it opened when it's shorter.
 */
function fitSide(moved: number, scale: number, start: number, length: number, origin: number, screen: number): number {
  const from = origin + scale * (start - origin);
  const size = scale * length;
  if (size <= screen) return start + length / 2 - (from + size / 2);
  return Math.min(-from, Math.max(screen - size - from, moved));
}

/** The view moved back inside the screen's edges. */
export function fit(view: View, layout: Layout): View {
  const { box, picture, screen } = layout;
  return {
    scale: view.scale,
    x: fitSide(view.x, view.scale, picture.left, picture.width, box.left, screen.width),
    y: fitSide(view.y, view.scale, picture.top, picture.height, box.top, screen.height),
  };
}

const clampScale = (scale: number) => Math.min(MAX_ZOOM, Math.max(1, scale));

/** Zoomed to `scale`, with what was under `at` still under it. */
export function zoomAround(view: View, scale: number, at: Point, layout: Layout): View {
  const next = clampScale(scale);
  const { box } = layout;
  return fit(
    {
      scale: next,
      x: at.x - box.left - (next * (at.x - box.left - view.x)) / view.scale,
      y: at.y - box.top - (next * (at.y - box.top - view.y)) / view.scale,
    },
    layout,
  );
}

/**
 * Two fingers that started at `from` and are now at `now`: the picture
 * grows or shrinks with the distance between them, and what was under the
 * point between them follows that point, so a pinch can drag as well.
 */
export function pinched(start: View, from: [Point, Point], now: [Point, Point], layout: Layout): View {
  const before = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const after = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y);
  const scale = clampScale(before > 0 ? (start.scale * after) / before : start.scale);
  const was = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const is = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 };
  const { box } = layout;
  return fit(
    {
      scale,
      x: is.x - box.left - (scale * (was.x - box.left - start.x)) / start.scale,
      y: is.y - box.top - (scale * (was.y - box.top - start.y)) / start.scale,
    },
    layout,
  );
}

/** One finger that started at `from` and is now at `now`: the picture follows it, as far as its edges allow. */
export function dragged(start: View, from: Point, now: Point, layout: Layout): View {
  return fit({ scale: start.scale, x: start.x + now.x - from.x, y: start.y + now.y - from.y }, layout);
}

export interface Zoom {
  /** A finger went down at (x, y). */
  down: (pointer: number, x: number, y: number) => void;
  /** It moved to (x, y). */
  move: (pointer: number, x: number, y: number) => void;
  /** It came up at (x, y). */
  up: (pointer: number, x: number, y: number) => void;
  /** The browser took it over, so it's no tap and no longer zooming. */
  cancel: (pointer: number) => void;
  /** Back to how the picture opened, at once, as when the window changes size. */
  reset: () => void;
  /** Forget every finger and any tap waiting, as when the viewer closes. */
  stop: () => void;
}

type Gesture =
  | { kind: "one"; pointer: number; from: Point; start: View; moved: boolean; layout: Layout | null }
  | { kind: "two"; pointers: [number, number]; from: [Point, Point]; start: View; layout: Layout | null };

/**
 * `layout` says where the picture sits, or null while there's none to zoom
 * (not loaded, or it couldn't be); taps still close then. `draw` is handed
 * every new view, `glide` when it jumps rather than following a finger.
 */
export function startZoom(
  layout: () => Layout | null,
  draw: (view: View, glide: boolean) => void,
  onTap: () => void,
  timers: HoldTimers = PAGE_TIMERS,
): Zoom {
  let view = UNZOOMED;
  const fingers = new Map<number, Point>();
  let gesture: Gesture | null = null;
  // A tap that may be the first of two, until `DOUBLE_TAP_MS` passes with
  // no finger down. One down then decides: lifted as a tap, it's the second.
  let first: Point | null = null;
  let timer: number | null = null;

  const show = (next: View, glide: boolean) => {
    view = next;
    draw(view, glide);
  };
  const forgetTap = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    first = null;
  };
  const tapped = (at: Point) => {
    if (first !== null && Math.hypot(at.x - first.x, at.y - first.y) <= DOUBLE_TAP_SLOP_PX) {
      forgetTap();
      const where = layout();
      if (where === null) return;
      show(view.scale > 1 ? fit(UNZOOMED, where) : zoomAround(view, DOUBLE_TAP_ZOOM, at, where), true);
      return;
    }
    forgetTap();
    first = at;
    timer = timers.set(() => {
      timer = null;
      // A finger is down again: whether it's a second tap is up to it.
      if (fingers.size > 0) return;
      first = null;
      if (view.scale === 1) onTap();
    }, DOUBLE_TAP_MS);
  };
  // Every finger lifted: a pinch that ended about where it began goes back there.
  const settle = (where: Layout | null) => {
    if (where === null || view.scale >= SNAP_ZOOM) return;
    if (view.scale !== 1 || view.x !== 0 || view.y !== 0) show(fit(UNZOOMED, where), true);
  };

  return {
    down(pointer, x, y) {
      fingers.set(pointer, { x, y });
      if (fingers.size === 1) {
        gesture = { kind: "one", pointer, from: { x, y }, start: view, moved: false, layout: layout() };
      } else if (fingers.size === 2) {
        // A second finger: a pinch, so no tap is coming from either.
        forgetTap();
        const [a, b] = [...fingers];
        if (a === undefined || b === undefined) return;
        gesture = { kind: "two", pointers: [a[0], b[0]], from: [a[1], b[1]], start: view, layout: gesture?.layout ?? layout() };
      }
    },
    move(pointer, x, y) {
      if (!fingers.has(pointer)) return;
      fingers.set(pointer, { x, y });
      if (gesture?.kind === "one" && gesture.pointer === pointer) {
        if (!gesture.moved && Math.hypot(x - gesture.from.x, y - gesture.from.y) > HOLD_SLOP_PX) {
          gesture.moved = true;
          forgetTap();
        }
        if (gesture.moved && gesture.layout !== null && gesture.start.scale > 1) show(dragged(gesture.start, gesture.from, { x, y }, gesture.layout), false);
      } else if (gesture?.kind === "two" && gesture.pointers.includes(pointer) && gesture.layout !== null) {
        const a = fingers.get(gesture.pointers[0]);
        const b = fingers.get(gesture.pointers[1]);
        if (a && b) show(pinched(gesture.start, gesture.from, [a, b], gesture.layout), false);
      }
    },
    up(pointer, x, y) {
      if (!fingers.has(pointer)) return;
      fingers.delete(pointer);
      const was = gesture;
      if (was?.kind === "two" && was.pointers.includes(pointer)) {
        // One finger left on the picture drags it on from here.
        const [left] = [...fingers];
        gesture = left ? { kind: "one", pointer: left[0], from: left[1], start: view, moved: true, layout: was.layout } : null;
      } else if (was?.kind === "one" && was.pointer === pointer) {
        gesture = null;
        if (!was.moved) tapped({ x, y });
        else if (first !== null) forgetTap();
      }
      if (fingers.size === 0) settle(was?.layout ?? null);
    },
    cancel(pointer) {
      if (!fingers.has(pointer)) return;
      fingers.delete(pointer);
      const was = gesture;
      gesture = null;
      forgetTap();
      if (fingers.size === 0) settle(was?.layout ?? null);
    },
    reset() {
      forgetTap();
      gesture = null;
      fingers.clear();
      show(UNZOOMED, false);
    },
    stop() {
      forgetTap();
      gesture = null;
      fingers.clear();
    },
  };
}
