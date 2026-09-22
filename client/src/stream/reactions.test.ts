import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REACTIONS, reactionOf, reactionTitle, reactionWeight } from "./reactions";

describe("the twelve", () => {
  it("is the same twelve the server has", () => {
    // The keys are a wire vocabulary, and the server rejects anything not in
    // `linger-core::REACTIONS` — so a client list that drifted would offer
    // people a mark that always fails, or quietly stop offering one that works.
    // ts-rs exports types, not constants, so the check reads the constant.
    const rust = readFileSync("../crates/linger-core/src/lib.rs", "utf8");
    const block = /pub const REACTIONS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rust);
    expect(block).not.toBeNull();
    const keys = [...(block?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((found) => found[1]);
    expect(REACTIONS.map((reaction) => reaction.key)).toEqual(keys);
  });

  it("gives every key a glyph and something to call it", () => {
    for (const reaction of REACTIONS) {
      expect(reaction.glyph.length).toBeGreaterThan(0);
      expect(reaction.label.length).toBeGreaterThan(0);
      expect(reactionOf(reaction.key)).toBe(reaction);
    }
  });

  it("does not recognise a key it was never given", () => {
    expect(reactionOf("thonk")).toBeUndefined();
  });
});

describe("weight", () => {
  it("starts at nothing for one person", () => {
    expect(reactionWeight(1)).toBe(0);
  });

  it("only ever grows", () => {
    let previous = -1;
    for (let count = 1; count <= 40; count += 1) {
      const weight = reactionWeight(count);
      expect(weight).toBeGreaterThanOrEqual(previous);
      expect(weight).toBeLessThanOrEqual(1);
      previous = weight;
    }
  });

  it("spends most of its range on the first few people", () => {
    // One to two is the step that means something; nine to ten means almost
    // nothing. Half the weight has to be gone by four reactors or the
    // interesting difference is invisible (SPEC §4.8).
    expect(reactionWeight(2)).toBeGreaterThan(0.3);
    expect(reactionWeight(4)).toBeGreaterThan(0.6);
    expect(reactionWeight(8)).toBe(1);
    expect(reactionWeight(80)).toBe(1);
  });
});

describe("the hover text", () => {
  it("names who reacted", () => {
    expect(reactionTitle(["Matt"], "heart")).toBe("Matt — heart");
    expect(reactionTitle(["Matt", "Callie"], "heart")).toBe("Matt and Callie — heart");
    expect(reactionTitle(["Matt", "Callie", "Sam"], "fire")).toBe("Matt, Callie and Sam — fire");
  });

  it("names everybody without substituting a numeric count", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(reactionTitle(names, "clap")).toBe("a, b, c, d, e, f, g and h — clap");
  });

  it("says only what the mark is when nobody is named", () => {
    expect(reactionTitle([], "eyes")).toBe("eyes");
  });
});
