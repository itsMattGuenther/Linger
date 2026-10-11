import { describe, expect, it } from "vitest";
import { HOLD_MS, HOLD_SLOP_PX, type HoldTimers, startHold } from "./hold";

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

function holding() {
  const time = clock();
  let holds = 0;
  const hold = startHold(() => (holds += 1), time.timers);
  return { hold, pass: time.pass, waiting: time.waiting, holds: () => holds };
}

describe("a hold on a touch screen (#573)", () => {
  it("is a finger kept down for half a second, and its click isn't a tap", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    pass(HOLD_MS - 1);
    expect(holds()).toBe(0);
    pass(1);
    expect(holds()).toBe(1);
    hold.end(1);
    // The mouse-down a browser makes up first doesn't use the click up.
    expect(hold.afterHold()).toBe(true);
    expect(hold.takeClick()).toBe(true);
    // Once: the next click is somebody's tap.
    expect(hold.takeClick()).toBe(false);
    expect(hold.afterHold()).toBe(false);
  });

  it("a quick tap is a tap: nothing held, its click goes through, and no timer is left behind", () => {
    const { hold, pass, holds, waiting } = holding();
    hold.down(1, 100, 100);
    pass(120);
    hold.end(1);
    expect(waiting()).toBe(0);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
    expect(hold.afterHold()).toBe(false);
    expect(hold.takeClick()).toBe(false);
  });

  it("a finger that moves is scrolling, and never becomes a hold", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    pass(200);
    hold.move(1, 100, 100 + HOLD_SLOP_PX + 1);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
    // Coming back to where it started doesn't bring the press back.
    hold.move(1, 100, 100);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
  });

  it("a finger that trembles a little is still holding", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    hold.move(1, 104, 106);
    hold.move(1, 97, 103);
    pass(HOLD_MS);
    expect(holds()).toBe(1);
  });

  it("the browser taking the finger to scroll ends the press", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    pass(300);
    hold.end(1);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
  });

  it("a second finger is a pinch, not a hold", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    hold.down(2, 200, 200);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
  });

  it("the phone's own long-press, coming first, is the hold, and ours doesn't come again", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    pass(400);
    expect(hold.now()).toBe(true);
    expect(holds()).toBe(1);
    pass(HOLD_MS);
    expect(holds()).toBe(1);
    hold.end(1);
    expect(hold.takeClick()).toBe(true);
  });

  it("the phone's long-press after ours, or after the finger lifts, is the same hold", () => {
    const { hold, pass, holds } = holding();
    hold.down(1, 100, 100);
    pass(HOLD_MS);
    expect(hold.now()).toBe(true);
    hold.end(1);
    expect(hold.now()).toBe(true);
    expect(holds()).toBe(1);
  });

  it("a long-press with no press seen (a mouse, a key) is the caller's to decide", () => {
    const { hold, holds } = holding();
    expect(hold.now()).toBe(false);
    hold.down(1, 100, 100);
    hold.end(1);
    expect(hold.now()).toBe(false);
    expect(holds()).toBe(0);
  });

  it("a new press forgets the last hold, so its tap is a tap", () => {
    const { hold, pass } = holding();
    hold.down(1, 100, 100);
    pass(HOLD_MS);
    hold.end(1);
    // No click came after that hold (Chrome sends none after a long-press).
    hold.down(2, 100, 100);
    hold.end(2);
    expect(hold.takeClick()).toBe(false);
    expect(hold.now()).toBe(false);
  });

  it("stopping forgets the press and its timer", () => {
    const { hold, pass, holds, waiting } = holding();
    hold.down(1, 100, 100);
    hold.stop();
    expect(waiting()).toBe(0);
    pass(HOLD_MS);
    expect(holds()).toBe(0);
    expect(hold.takeClick()).toBe(false);
  });
});
