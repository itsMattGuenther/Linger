import { describe, expect, it } from "vitest";
import type { UserStatus } from "../../generated/UserStatus";
import { AWAY_BANK_SIZE, AWAY_PRESETS, bankOf, forgetAway, lineProblem, rememberAway, startingBank, withAway, withLine } from "./you";

const status: UserStatus = {
  line: "fixing the porch light (the real one)",
  reading: null,
  listening: "Khruangbin",
  working_on: "a design for this app",
  fields: [
    { label: "Listening to", value: "Khruangbin" },
    { label: "GitHub", value: "github.com/bendthebracket" },
    { label: "Working on", value: "a design for this app" },
  ],
  image_id: "img-1",
  image_url: "https://cdn.example/img-1",
  away_message: null,
  away_since: null,
};

/** What a save carries: the same status, with no picture (#269). */
const words: UserStatus = { ...status, image_id: null, image_url: null };

describe("changing your status from the list", () => {
  it("changes the line and keeps everything else", () => {
    const next = withLine(status, "  second coffee  ");
    expect(next).toEqual({ ...words, line: "second coffee" });
  });

  it("clears the line when it's blank", () => {
    expect(withLine(status, "   ").line).toBeNull();
  });

  it("goes away with a message and comes back, keeping the rest", () => {
    const away = withAway(status, "walking the dog 🐕");
    expect(away).toEqual({ ...words, away_message: "walking the dog 🐕" });
    expect(withAway(away, null)).toEqual({ ...words, away_message: null });
  });

  it("never sends a picture, even one an older server still has (#269)", () => {
    expect(withLine(status, "second coffee")).toMatchObject({ image_id: null, image_url: null });
    expect(withAway(status, "asleep")).toMatchObject({ image_id: null, image_url: null });
  });

  it("keeps your own labelled fields, in their order (#270)", () => {
    expect(withLine(status, "second coffee").fields).toEqual(status.fields);
    expect(withAway(status, "asleep").fields).toEqual(status.fields);
  });

  it("from an older server with no fields, keeps its three and sends them as fields too", () => {
    const older: UserStatus = { ...words, fields: null };
    expect(withLine(older, "second coffee")).toMatchObject({
      listening: "Khruangbin",
      working_on: "a design for this app",
      fields: [
        { label: "Listening to", value: "Khruangbin" },
        { label: "Working on", value: "a design for this app" },
      ],
    });
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

describe("your bank of away messages (#708)", () => {
  it("starts as the built-in ones", () => {
    expect(startingBank([])).toEqual([...AWAY_PRESETS]);
    expect(AWAY_PRESETS).toHaveLength(AWAY_BANK_SIZE);
  });

  it("starts from a device's recent messages, then the built-in ones, without repeats", () => {
    expect(startingBank(["at the gym", "Asleep 💤"])).toEqual(["at the gym", "Asleep 💤", "back after work", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
  });

  it("puts a message you go away with at the top, and the bottom one drops off at seven", () => {
    let bank = startingBank([]);
    bank = rememberAway(bank, "  at the gym ");
    expect(bank).toEqual(["at the gym", "back after work", "asleep 💤", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    bank = rememberAway(bank, "walking the dog 🐕");
    expect(bank).toEqual(["walking the dog 🐕", "at the gym", "back after work", "asleep 💤", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    expect(rememberAway(bank, "  ")).toEqual(bank);
  });

  it("takes out the one beside its ×, a built-in one too, and leaves its place empty", () => {
    let bank = rememberAway(startingBank([]), "at the gym");
    bank = forgetAway(bank, "asleep 💤");
    bank = forgetAway(bank, "at the gym");
    expect(bank).toEqual(["back after work", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    // Taken out stays out: going away with another doesn't bring it back.
    expect(rememberAway(bank, "lunch")).toEqual(["lunch", "back after work", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    // Going away with it again does.
    expect(rememberAway(bank, "asleep 💤")[0]).toBe("asleep 💤");
    expect(forgetAway([], "lunch")).toEqual([]);
  });

  it("reads a kept bank, and nothing else as one", () => {
    expect(bankOf(["lunch", 4, " lunch ", "", "nap"])).toEqual(["lunch", "nap"]);
    expect(bankOf([])).toEqual([]);
    expect(bankOf(["1", "2", "3", "4", "5", "6", "7"])).toHaveLength(AWAY_BANK_SIZE);
    expect(bankOf({ lunch: true })).toBeNull();
    expect(bankOf(null)).toBeNull();
  });
});
