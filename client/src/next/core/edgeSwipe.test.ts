import { describe, expect, it } from "vitest";
import { BACK_SHARE, EDGE_PX, FLICK_MS, goesBack, startEdgeSwipe } from "./edgeSwipe";
import { HOLD_MS, HOLD_SLOP_PX } from "./hold";

/** A phone's screen, this wide. */
const WIDTH = 390;

function swiping(refuse = false) {
  const moves: string[] = [];
  let at = 0;
  const swipe = startEdgeSwipe(() => WIDTH, {
    take: () => {
      moves.push("take");
      return !refuse;
    },
    follow: (by) => void moves.push(`follow ${by}`),
    done: (back) => void moves.push(back ? "back" : "home"),
  });
  /** One finger from (x, y) along `steps` moves of (dx, dy), `ms` apart: what each move answered. */
  const drag = (x: number, y: number, dx: number, dy: number, steps: number, ms = 40) => {
    swipe.down(1, x, y, at, 1);
    const answers: boolean[] = [];
    for (let step = 1; step <= steps; step += 1) {
      at += ms;
      answers.push(swipe.move(1, x + dx * step, y + dy * step, at));
    }
    return answers;
  };
  const lift = (after = 16) => {
    at += after;
    swipe.up(1, at);
  };
  return { swipe, moves, drag, lift, wait: (ms: number) => (at += ms), now: () => at };
}

describe("an iPhone's swipe in from the left edge (#697)", () => {
  it("is a finger from the edge moving right: the screen follows it, and let go past a third of the way it goes back", () => {
    const { moves, drag, lift } = swiping();
    // Slowly: no flick about it.
    const answers = drag(4, 400, 8, 0, 20);
    // Within a hold's slop the page may still scroll; past it the swipe has the finger.
    expect(answers[0]).toBe(false);
    expect(answers.slice(1).every(Boolean)).toBe(true);
    expect(moves[0]).toBe("take");
    expect(moves[1]).toBe(`follow ${2 * 8}`);
    expect(moves.at(-1)).toBe(`follow ${20 * 8}`);
    expect(20 * 8).toBeGreaterThan(WIDTH * BACK_SHARE);
    lift();
    expect(moves.at(-1)).toBe("back");
  });

  it("let go short of a third, it slides back into place", () => {
    const { moves, drag, lift } = swiping();
    drag(4, 400, 8, 0, 12);
    expect(12 * 8).toBeLessThan(WIDTH * BACK_SHARE);
    lift();
    expect(moves.at(-1)).toBe("home");
  });

  it("a quick flick to the right goes back from anywhere, but not one that stopped before it lifted", () => {
    const flicked = swiping();
    flicked.drag(4, 400, 16, 0, 5, 8);
    flicked.lift(8);
    expect(flicked.moves.at(-1)).toBe("back");

    const stopped = swiping();
    stopped.drag(4, 400, 16, 0, 5, 8);
    stopped.lift(FLICK_MS + 50);
    expect(stopped.moves.at(-1)).toBe("home");
  });

  it("past a third but flicked back to the left at the end, it slides back into place", () => {
    const { swipe, moves, drag, wait, now } = swiping();
    drag(4, 400, 10, 0, 30);
    // From 304 back to 224, fast.
    for (let step = 1; step <= 4; step += 1) {
      wait(8);
      swipe.move(1, 304 - step * 20, 400, now());
    }
    expect(224 - 4).toBeGreaterThan(WIDTH * BACK_SHARE);
    wait(8);
    swipe.up(1, now());
    expect(moves.at(-1)).toBe("home");
  });

  it("never follows the finger left of where the screen was", () => {
    const { swipe, moves, drag, now } = swiping();
    drag(10, 400, 10, 0, 3);
    swipe.move(1, 2, 400, now() + 40);
    expect(moves.at(-1)).toBe("follow 0");
  });

  it("a finger landing further in than the edge is no swipe, however it moves", () => {
    const { moves, drag, lift } = swiping();
    expect(drag(EDGE_PX + 1, 400, 10, 0, 30).some(Boolean)).toBe(false);
    lift();
    expect(moves).toEqual([]);
  });

  it("a finger from the edge going up, down or left is a scroll, left to the page", () => {
    for (const [dx, dy] of [
      [2, -10],
      [2, 10],
      [-10, 0],
      [6, 6],
    ] as const) {
      const { moves, drag, lift } = swiping();
      expect(drag(10, 400, dx, dy, 20).some(Boolean)).toBe(false);
      lift();
      expect(moves).toEqual([]);
    }
  });

  it("a finger held still till it's a hold is a hold, and moving right after doesn't make it a swipe (core/hold.ts)", () => {
    const { swipe, moves, wait, now } = swiping();
    swipe.down(1, 6, 400, now(), 1);
    wait(HOLD_MS);
    // A hold's own slop, as hold.ts allows.
    expect(swipe.move(1, 6 + HOLD_SLOP_PX, 400, now())).toBe(false);
    wait(20);
    expect(swipe.move(1, 200, 400, now())).toBe(false);
    swipe.up(1, now() + 16);
    expect(moves).toEqual([]);
  });

  it("is one finger alone: a second is a pinch, and one landing at the edge beside another is no swipe", () => {
    const pinch = swiping();
    pinch.drag(4, 400, 10, 0, 5);
    expect(pinch.moves[0]).toBe("take");
    pinch.swipe.down(2, 200, 500, pinch.now(), 2);
    expect(pinch.moves.at(-1)).toBe("home");
    expect(pinch.swipe.move(1, 120, 400, pinch.now() + 40)).toBe(false);

    const beside = swiping();
    beside.swipe.down(2, 4, 400, 0, 2);
    expect(beside.swipe.move(2, 200, 400, 40)).toBe(false);
    expect(beside.moves).toEqual([]);
  });

  it("taken away by the browser, or with nothing left to go back from, it slides back into place", () => {
    const cancelled = swiping();
    cancelled.drag(4, 400, 10, 0, 20);
    cancelled.swipe.cancel(1);
    expect(cancelled.moves.at(-1)).toBe("home");

    const stopped = swiping();
    stopped.drag(4, 400, 10, 0, 20);
    stopped.swipe.stop();
    expect(stopped.moves.at(-1)).toBe("home");
    stopped.lift();
    expect(stopped.moves.filter((move) => move === "home" || move === "back")).toEqual(["home"]);
  });

  it("refused as it starts, it leaves the finger to the page", () => {
    const { moves, drag, lift } = swiping(true);
    expect(drag(4, 400, 10, 0, 20).some(Boolean)).toBe(false);
    lift();
    expect(moves).toEqual(["take"]);
  });

  it("a fresh finger forgets one whose lifting never arrived", () => {
    const { swipe, moves, drag, now } = swiping();
    drag(4, 400, 10, 0, 5);
    swipe.down(7, 4, 300, now() + 100, 1);
    expect(moves.at(-1)).toBe("home");
    expect(swipe.move(7, 60, 300, now() + 140)).toBe(true);
  });
});

describe("how a swipe let go of ends", () => {
  it("goes back past a third of the width, or flicked, and not otherwise", () => {
    const still = [{ x: 200, at: 0 }];
    expect(goesBack(WIDTH * BACK_SHARE, WIDTH, still, 16)).toBe(true);
    expect(goesBack(WIDTH * BACK_SHARE - 1, WIDTH, still, 16)).toBe(false);
    const flick = [
      { x: 40, at: 0 },
      { x: 90, at: 50 },
    ];
    expect(goesBack(90, WIDTH, flick, 60)).toBe(true);
    const back = [
      { x: 300, at: 0 },
      { x: 250, at: 50 },
    ];
    expect(goesBack(250, WIDTH, back, 60)).toBe(false);
  });
});
