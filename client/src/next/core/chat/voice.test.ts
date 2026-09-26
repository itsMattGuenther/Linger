import { describe, expect, it } from "vitest";
import { voiceStrip } from "./voice";

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

  it("doesn't count you among the others when your seat is on another server", () => {
    expect(voiceStrip("r-general", ["matt"], "matt", "elsewhere")).toEqual({ kind: "quiet", action: "move" });
  });
});
