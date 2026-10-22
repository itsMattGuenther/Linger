/**
 * Going back with a finger swiped in from the screen's left edge, on an
 * iPhone (#697). Android's Back is the phone's own, its button and its edge
 * gesture both, and reaches the page as Back (app/useBackButton.ts). An
 * iPhone has neither: each of its apps goes back with this swipe itself, so
 * Linger does too.
 *
 * A finger that lands within `EDGE_PX` of the left edge, alone, may be one.
 * Once it has moved further than a hold allows (`HOLD_SLOP_PX`), it's a
 * swipe if it went more to the right than up or down, and wasn't already
 * held still long enough to be a hold (`HOLD_MS`). Anything else is left to
 * what it was: a scroll, a hold, a tap, or a pinch. Before that the caller
 * lets the page scroll as usual, so a finger scrolling up from the edge
 * still scrolls.
 *
 * Taken, the screen follows the finger, never left of where it was. Let go
 * past `BACK_SHARE` of the screen's width, or flicked to the right, it goes
 * back; let go short of that, or flicked back to the left, it slides back
 * into place, as an iPhone's own screens do.
 *
 * No DOM here, as in hold.ts and zoom.ts: the caller hands in where the
 * finger is and when, and moves the screen (`edgeSwipe.test.ts`).
 */
import { HOLD_MS, HOLD_SLOP_PX } from "./hold";

/** How near the left edge a finger lands to start one, in CSS pixels: about what an iPhone's own apps allow. */
export const EDGE_PX = 20;

/** How far over the screen has to be when the finger lifts, as a share of its width, to go back. */
export const BACK_SHARE = 1 / 3;

/** How fast a flick goes back from anywhere, in CSS pixels a millisecond (500 a second). */
export const FLICK_PX_PER_MS = 0.5;

/** How much of the end of a swipe its speed is measured over. */
export const FLICK_MS = 100;

/** What the caller does as a swipe goes. */
export interface SwipeMoves {
  /**
   * It's a swipe: the screen starts following the finger. False refuses it
   * (what it would go back from has gone), and the finger is left alone.
   */
  take: () => boolean;
  /** The screen is `by` CSS pixels right of where it was. */
  follow: (by: number) => void;
  /** Let go: true goes back, false slides back into place. */
  done: (back: boolean) => void;
}

export interface EdgeSwipe {
  /** A finger landed at (x, y), `at` milliseconds in, with `fingers` on the screen now, this one too. */
  down: (finger: number, x: number, y: number, at: number, fingers: number) => void;
  /** It moved. True while the swipe has it, so the caller keeps the page from scrolling with it. */
  move: (finger: number, x: number, y: number, at: number) => boolean;
  /** It lifted. */
  up: (finger: number, at: number) => void;
  /** The browser took it. */
  cancel: (finger: number) => void;
  /** Forget any finger, as when there's nothing left to go back from; a swipe under way slides back. */
  stop: () => void;
}

interface Press {
  finger: number;
  x: number;
  y: number;
  at: number;
  taken: boolean;
  /** Where it has been lately, for how fast it was going when it lifted. */
  lately: { x: number; at: number }[];
}

/**
 * Whether a swipe let go of `by` pixels over, on a screen `width` wide, goes
 * back. `lately` is where the finger was over its last moves and `at` when
 * it lifted: a finger that stopped before lifting wasn't flicked.
 */
export function goesBack(by: number, width: number, lately: readonly { x: number; at: number }[], at: number): boolean {
  const recent = lately.filter((point) => at - point.at <= FLICK_MS);
  const first = recent[0];
  const last = recent.at(-1);
  const speed = first && last && last !== first ? (last.x - first.x) / Math.max(at - first.at, 1) : 0;
  if (speed >= FLICK_PX_PER_MS) return true;
  return by >= width * BACK_SHARE && speed > -FLICK_PX_PER_MS;
}

/** `width` is the screen's, in CSS pixels, read as each swipe ends. */
export function startEdgeSwipe(width: () => number, moves: SwipeMoves): EdgeSwipe {
  let press: Press | null = null;

  // Forget the finger; a swipe it was making slides back.
  const drop = () => {
    const was = press;
    press = null;
    if (was?.taken) moves.done(false);
  };

  return {
    down(finger, x, y, at, fingers) {
      // A second finger: a pinch, so no swipe from either.
      drop();
      if (fingers === 1 && x <= EDGE_PX) press = { finger, x, y, at, taken: false, lately: [] };
    },
    move(finger, x, y, at) {
      if (press === null || press.finger !== finger) return false;
      const dx = x - press.x;
      const dy = y - press.y;
      if (!press.taken) {
        if (Math.hypot(dx, dy) <= HOLD_SLOP_PX) return false;
        // Held still till it was a hold, or on its way up, down or left:
        // not a swipe, whatever it does next.
        if (at - press.at >= HOLD_MS || dx <= Math.abs(dy) || !moves.take()) {
          press = null;
          return false;
        }
        press.taken = true;
      }
      press.lately = [...press.lately.filter((point) => at - point.at <= FLICK_MS), { x, at }];
      moves.follow(Math.max(0, dx));
      return true;
    },
    up(finger, at) {
      if (press === null || press.finger !== finger) return;
      const was = press;
      press = null;
      if (!was.taken) return;
      const last = was.lately.at(-1);
      moves.done(goesBack(Math.max(0, (last?.x ?? was.x) - was.x), width(), was.lately, at));
    },
    cancel(finger) {
      if (press?.finger === finger) drop();
    },
    stop() {
      drop();
    },
  };
}
