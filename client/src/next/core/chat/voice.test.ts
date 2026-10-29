import { describe, expect, it } from "vitest";
import { stripFit, voiceStrip } from "./voice";

describe("a conversation's voice strip", () => {
  it("says you're in voice here, with no way in to offer", () => {
    expect(voiceStrip("r-general", ["eli", "matt"], "matt", "r-general")).toEqual({ kind: "mine", people: ["eli", "matt"] });
  });

  it("offers to join others when you're not in voice anywhere", () => {
    expect(voiceStrip("r-general", ["eli", "jules"], "matt", null)).toEqual({ kind: "others", people: ["eli", "jules"], action: "join" });
  });

  it("offers to move, never a fresh join, when you're in voice somewhere else", () => {
    expect(voiceStrip("r-general", ["eli"], "matt", "r-listening")).toEqual({ kind: "others", people: ["eli"], action: "move" });
    expect(voiceStrip("r-plans", [], "matt", "r-general")).toEqual({ kind: "quiet", action: "move" });
  });

  it("offers to start talking in a quiet room", () => {
    expect(voiceStrip("r-plans", [], "matt", null)).toEqual({ kind: "quiet", action: "start" });
  });

  it("offers nothing on a server that carries no voice (#306)", () => {
    expect(voiceStrip("r-plans", [], "matt", null, false)).toEqual({ kind: "off" });
    expect(voiceStrip("r-plans", [], "matt", "elsewhere", false)).toEqual({ kind: "off" });
    // A server that hasn't said is given the benefit of the doubt.
    expect(voiceStrip("r-plans", [], "matt", null)).toEqual({ kind: "quiet", action: "start" });
  });

  it("doesn't count you among the others when your seat is on another server", () => {
    expect(voiceStrip("r-general", ["matt"], "matt", "elsewhere")).toEqual({ kind: "quiet", action: "move" });
  });
});

describe("how many people a voice strip shows (#745)", () => {
  const chips = (...widths: number[]) => widths.map((width, n) => ({ id: `u${n}`, width }));
  const words = { some: 80, all: 0 };

  it("shows everybody when they all fit", () => {
    // 3 chips of 60 with 2 gaps of 6: 192.
    expect(stripFit({ chips: chips(60, 60, 60), gap: 6, words, you: null }, 192)).toEqual({ kind: "all" });
  });

  it("leaves room for the words that go with everybody", () => {
    const measure = { chips: chips(60, 60, 60), gap: 6, words: { some: 150, all: 70 }, you: null };
    expect(stripFit(measure, 262)).toEqual({ kind: "all" });
    expect(stripFit(measure, 261)).toEqual({ kind: "first", count: 1 });
  });

  it("shows as many as fit beside \"and others\", in order, and more as the line widens", () => {
    const measure = { chips: chips(60, 90, 60, 60, 60), gap: 6, words, you: null };
    // 60 + 6 + 90 = 156, and 80 for the words: 236.
    expect(stripFit(measure, 236)).toEqual({ kind: "first", count: 2 });
    expect(stripFit(measure, 235)).toEqual({ kind: "first", count: 1 });
    expect(stripFit(measure, 302)).toEqual({ kind: "first", count: 3 });
    expect(stripFit(measure, 1000)).toEqual({ kind: "all" });
  });

  it("stops at the first that doesn't fit, so the order holds", () => {
    // The third is wide; the fourth would fit after the second, but isn't shown out of turn.
    expect(stripFit({ chips: chips(50, 50, 300, 20, 20), gap: 0, words, you: null }, 200)).toEqual({ kind: "first", count: 2 });
  });

  it("never shows fewer than one, even on a line too narrow for it", () => {
    expect(stripFit({ chips: chips(200, 60), gap: 6, words, you: null }, 50)).toEqual({ kind: "first", count: 1 });
  });

  it("forgives half a pixel of rounding", () => {
    expect(stripFit({ chips: chips(60.3, 60.3), gap: 6, words, you: null }, 126.4)).toEqual({ kind: "all" });
  });

  it("in a big room you're in, counts the seats the widest of the others would fill, so a talker taking one never changes how many", () => {
    // Everybody is 440 of chips and 36 of gaps: 476.
    const measure = { chips: [{ id: "me", width: 40 }, ...chips(60, 100, 50, 70, 60, 60)], gap: 6, words, you: "me" };
    expect(stripFit(measure, 476)).toEqual({ kind: "all" });
    // You 40 and the words 80: 120. Then the widest, each with its gap:
    // 100 to 226, 70 to 302, 60 to 368, 60 to 434.
    expect(stripFit(measure, 433)).toEqual({ kind: "seats", seats: 3 });
    expect(stripFit(measure, 434)).toEqual({ kind: "seats", seats: 4 });
    expect(stripFit(measure, 475)).toEqual({ kind: "seats", seats: 4 });
    expect(stripFit(measure, 120)).toEqual({ kind: "seats", seats: 0 });
    expect(stripFit(measure, 10_000)).toEqual({ kind: "all" });
  });

  it("always leaves somebody to \"and others\" when it seats", () => {
    // Everybody nearly fits, but the widest is far wider than the rest.
    const measure = { chips: [{ id: "me", width: 40 }, { id: "a", width: 300 }, { id: "b", width: 10 }], gap: 0, words: { some: 0, all: 10 }, you: "me" };
    const fit = stripFit(measure, 345);
    expect(fit).toEqual({ kind: "seats", seats: 1 });
  });
});
