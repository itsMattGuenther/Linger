/**
 * Telling a hold from a tap and from a scroll, for a finger on a touch
 * screen (#573): holding a reaction pill shows who left it, as Discord does,
 * where a tap adds yours or takes it back.
 *
 * A press becomes a hold when the finger stays down `HOLD_MS` without
 * moving more than `HOLD_SLOP_PX`. A finger that moves further is
 * scrolling the conversation, so the press is dropped; so is one the
 * browser takes over to scroll (`pointercancel`), and a second finger,
 * which is a pinch. The phone's own long-press (`contextmenu`) can come
 * first: `now` makes it the hold straight away, so the two never show two
 * things.
 *
 * Once a press has been a hold, the click that may follow its release is
 * not a tap: `takeClick` says to swallow it, once. A click from the
 * keyboard is never swallowed; the caller checks for one (`detail` 0).
 * Some browsers send that click after a long-press and some don't, so it's
 * forgotten when the next press starts.
 *
 * No DOM here: the caller hands in where the finger is and a clock, so the
 * timing is tested on its own (`hold.test.ts`).
 */

/** How long a finger stays down before it's a hold: about what a phone waits for its own long-press. */
export const HOLD_MS = 500;

/** How far a finger may drift and still be holding, in CSS pixels; further is a scroll. */
export const HOLD_SLOP_PX = 10;

/** The clock a hold waits on: the page's timers, or a test's. */
export interface HoldTimers {
  set: (run: () => void, ms: number) => number;
  clear: (id: number) => void;
}

export const PAGE_TIMERS: HoldTimers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (id) => window.clearTimeout(id),
};

export interface Hold {
  /** A finger went down at (x, y). */
  down: (pointer: number, x: number, y: number) => void;
  /** It moved to (x, y). */
  move: (pointer: number, x: number, y: number) => void;
  /** It came up, or the browser took it over to scroll. */
  end: (pointer: number) => void;
  /**
   * The phone's own long-press arrived. True when it belongs to a press
   * this saw (it's the hold now, if it wasn't already); false when there's
   * been none, so the caller decides.
   */
  now: () => boolean;
  /**
   * Whether the press the page is now finishing was a hold, so the
   * mouse-down a browser makes up for it shouldn't move the focus out of
   * what the hold opened. Asks without using up the click.
   */
  afterHold: () => boolean;
  /** Whether the click now arriving followed a hold, and so isn't a tap. Says yes once. */
  takeClick: () => boolean;
  /** Forget any press, as when what it was on goes away. */
  stop: () => void;
}

export function startHold(onHold: () => void, timers: HoldTimers = PAGE_TIMERS, ms = HOLD_MS, slop = HOLD_SLOP_PX): Hold {
  let press: { pointer: number; x: number; y: number } | null = null;
  let timer: number | null = null;
  // The last press was a hold, until the next one starts: the phone's own
  // long-press for it is taken, not shown.
  let held = false;
  // Its click, if one comes, is swallowed.
  let swallow = false;

  const wait = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const drop = () => {
    wait();
    press = null;
  };
  const hold = () => {
    wait();
    held = true;
    swallow = true;
    onHold();
  };

  return {
    down(pointer, x, y) {
      // A second finger: a pinch, not a hold.
      if (press !== null && press.pointer !== pointer) {
        drop();
        return;
      }
      wait();
      held = false;
      swallow = false;
      press = { pointer, x, y };
      timer = timers.set(() => {
        timer = null;
        if (press !== null) hold();
      }, ms);
    },
    move(pointer, x, y) {
      if (press === null || press.pointer !== pointer || held) return;
      if (Math.hypot(x - press.x, y - press.y) > slop) drop();
    },
    end(pointer) {
      if (press !== null && press.pointer === pointer) drop();
    },
    now() {
      if (held) return true;
      if (press === null) return false;
      hold();
      return true;
    },
    afterHold() {
      return swallow;
    },
    takeClick() {
      const was = swallow;
      swallow = false;
      return was;
    },
    stop() {
      drop();
      held = false;
      swallow = false;
    },
  };
}
