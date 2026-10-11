import { describe, expect, it } from "vitest";
import { ANYWHERE, heard, held, NOBODY, type TalkEdge, type TalkHolders } from "./talkHold";

/** The holders after a run of reports, from nobody. */
function after(...reports: [string, TalkEdge][]): TalkHolders {
  return reports.reduce((holders, [from, edge]) => heard(holders, from, edge), NOBODY);
}

describe("who holds the talk key (#500)", () => {
  it("a press heard by a window and by the watcher is one press", () => {
    expect(held(after(["main", "down"], [ANYWHERE, "down"]))).toBe(true);
    // Heard twice by the same one (a repeat, or a stale report) changes nothing.
    const once = after(["main", "down"]);
    expect(heard(once, "main", "down")).toBe(once);
  });

  it("whoever hears the key come up first lets go of it for everyone: there is one key", () => {
    expect(held(after(["main", "down"], [ANYWHERE, "down"], [ANYWHERE, "up"]))).toBe(false);
    expect(held(after(["main", "down"], [ANYWHERE, "down"], ["chat-1", "up"]))).toBe(false);
  });

  it("a window losing focus lets go of only its own press, so the watcher keeps the key held", () => {
    const switched = after(["main", "down"], [ANYWHERE, "down"], ["main", "away"]);
    expect(held(switched)).toBe(true);
    expect(held(heard(switched, ANYWHERE, "up"))).toBe(false);
    // Where nothing watches anywhere, leaving the window lets go, as it always has.
    expect(held(after(["main", "down"], ["main", "away"]))).toBe(false);
  });

  it("the watcher stopping lets go of its press, and a window's goes on", () => {
    expect(held(after([ANYWHERE, "down"], [ANYWHERE, "away"]))).toBe(false);
    expect(held(after([ANYWHERE, "down"], ["chat-1", "down"], [ANYWHERE, "away"]))).toBe(true);
  });

  it("going away without having pressed changes nothing", () => {
    const holders = after([ANYWHERE, "down"]);
    expect(heard(holders, "chat-1", "away")).toBe(holders);
    expect(held(NOBODY)).toBe(false);
  });
});
