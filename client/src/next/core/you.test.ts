import { describe, expect, it } from "vitest";
import type { UserStatus } from "../../generated/UserStatus";
import { AWAY_PRESETS, awayChoices, lineProblem, rememberAway, withAway, withLine } from "./you";

const status: UserStatus = {
  line: "fixing the porch light (the real one)",
  reading: null,
  listening: "Khruangbin",
  working_on: "a design for this app",
  image_id: "img-1",
  image_url: "https://cdn.example/img-1",
  away_message: null,
  away_since: null,
};

describe("changing your status from the list", () => {
  it("changes the line and keeps everything else", () => {
    const next = withLine(status, "  second coffee  ");
    expect(next).toEqual({ ...status, line: "second coffee" });
  });

  it("clears the line when it's blank", () => {
    expect(withLine(status, "   ").line).toBeNull();
  });

  it("goes away with a message and comes back, keeping the rest", () => {
    const away = withAway(status, "walking the dog 🐕");
    expect(away).toEqual({ ...status, away_message: "walking the dog 🐕" });
    expect(withAway(away, null)).toEqual({ ...status, away_message: null });
  });

  it("works for someone with no status yet", () => {
    expect(withLine(null, "hello").line).toBe("hello");
    expect(withAway(undefined, "asleep").away_message).toBe("asleep");
  });

  it("says in words when a line is too long", () => {
    expect(lineProblem("a".repeat(240))).toBeNull();
    expect(lineProblem("a".repeat(243))).toBe("That's 3 characters too long.");
  });
});

describe("away presets", () => {
  it("offers your own recent messages first, then the built-in ones, without repeats", () => {
    expect(awayChoices(["at the gym", "Asleep 💤"])).toEqual(["at the gym", "Asleep 💤", "back after work", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    expect(awayChoices([])).toEqual([...AWAY_PRESETS]);
  });

  it("remembers what you wrote yourself, newest first, a few at most", () => {
    let recent: string[] = [];
    for (const message of ["one", "two", "three", "four", "five", "two"]) recent = rememberAway(recent, message);
    expect(recent).toEqual(["two", "five", "four", "three"]);
    expect(rememberAway(recent, "asleep 💤")).toEqual(recent);
    expect(rememberAway(recent, "  ")).toEqual(recent);
  });
});
