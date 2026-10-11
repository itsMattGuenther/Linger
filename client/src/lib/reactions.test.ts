import { describe, expect, it } from "vitest";
import type { ReactionGroup } from "../generated/ReactionGroup";
import { MAX_REACTIONS, customIdOf, customKey, hasRoom, reactedWords, shownGroups, toggled, withGroup } from "./reactions";

const fire: ReactionGroup = { key: "🔥", count: 2, user_ids: ["u-a", "u-b"] };
const laugh: ReactionGroup = { key: "😂", count: 1, user_ids: ["u-c"] };

describe("reactions (#485)", () => {
  it("folds an update in its place, adds a new one last, and drops one nobody's left", () => {
    expect(withGroup([fire, laugh], { key: "🔥", count: 3, user_ids: ["u-a", "u-b", "u-c"] })).toEqual([
      { key: "🔥", count: 3, user_ids: ["u-a", "u-b", "u-c"] },
      laugh,
    ]);
    expect(withGroup([fire], laugh)).toEqual([fire, laugh]);
    expect(withGroup([fire, laugh], { key: "🔥", count: 0, user_ids: [] })).toEqual([laugh]);
    expect(withGroup([laugh], { key: "🔥", count: 0, user_ids: [] })).toEqual([laugh]);
    // Nothing changed: the same list back, so nothing redraws.
    const held = [fire, laugh];
    expect(withGroup(held, { ...fire, user_ids: [...fire.user_ids] })).toBe(held);
    expect(withGroup(held, { key: "👍", count: 0, user_ids: [] })).toBe(held);
  });

  it("adds you to a group or takes you out, without doubling you", () => {
    expect(toggled([fire], "🔥", "u-me", true)).toEqual({ key: "🔥", count: 3, user_ids: ["u-a", "u-b", "u-me"] });
    expect(toggled([fire], "🔥", "u-a", true)).toEqual({ key: "🔥", count: 2, user_ids: ["u-b", "u-a"] });
    expect(toggled([fire], "🔥", "u-a", false)).toEqual({ key: "🔥", count: 1, user_ids: ["u-b"] });
    expect(toggled([], "👍", "u-me", true)).toEqual({ key: "👍", count: 1, user_ids: ["u-me"] });
  });

  it("names a server emoji by id, and draws none whose emoji is gone", () => {
    expect(customKey({ id: "0123abcd" })).toBe("emoji:0123abcd");
    expect(customIdOf("emoji:0123abcd")).toBe("0123abcd");
    expect(customIdOf("👍")).toBeNull();
    const porch = { key: "emoji:porch", count: 1, user_ids: ["u-a"] };
    const gone = { key: "emoji:gone", count: 1, user_ids: ["u-a"] };
    const set = new Map([["porch", { id: "porch", name: "porch_light", url: "", animated: false, created_by: "u-m", created_at: 0 }]]);
    expect(shownGroups([fire, porch, gone], set)).toEqual([fire, porch]);
  });

  it("holds six different at most", () => {
    expect(MAX_REACTIONS).toBe(6);
    const five = ["1", "2", "3", "4", "5"].map((key) => ({ key, count: 1, user_ids: ["u-a"] }));
    expect(hasRoom(five)).toBe(true);
    expect(hasRoom([...five, laugh])).toBe(false);
  });

  it("says who reacted, and a server emoji's name", () => {
    expect(reactedWords(["You"], null)).toBe("You reacted");
    expect(reactedWords(["Jules", "Dave"], "porch_light")).toBe("Jules and Dave reacted with :porch_light:");
    expect(reactedWords(["Eli", "Jules", "You"], null)).toBe("Eli, Jules and You reacted");
  });
});
