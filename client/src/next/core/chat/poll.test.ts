import { describe, expect, it } from "vitest";
import type { Poll } from "../../../generated/Poll";
import { nextVote, pollCommand, pollNonce, pollOpen, resultWords, typingPoll, votesOf } from "./poll";

const poll = (multi = false): Poll => ({
  question: "Which faction?",
  choices: [
    { text: "Horde", voter_ids: ["u-eli", "u-matt"] },
    { text: "Alliance", voter_ids: ["u-jules"] },
    { text: "Don't care", voter_ids: [] },
  ],
  multi,
  closes_at: 2_000,
  closed_at: null,
  closed_by: null,
});

describe("/poll in the box (#474)", () => {
  it("reads the question after the command, and nothing else as the command", () => {
    expect(pollCommand("/poll Which faction?")).toBe("Which faction?");
    expect(pollCommand("  /POLL  ")).toBe("");
    expect(pollCommand("/polls are fun")).toBeNull();
    expect(pollCommand("let's do a /poll")).toBeNull();
  });

  it("says what it does from /p on, and not for a lone / or /motd", () => {
    expect(typingPoll("/p")).toBe(true);
    expect(typingPoll("/pol")).toBe(true);
    expect(typingPoll("/poll Which")).toBe(true);
    expect(typingPoll("/")).toBe(false);
    expect(typingPoll("/m")).toBe(false);
    expect(typingPoll("/pizza")).toBe(false);
  });
});

describe("a poll's votes (#474)", () => {
  it("pick-one moves your vote, or takes it back", () => {
    expect(nextVote(poll(), [], 1)).toEqual([1]);
    expect(nextVote(poll(), [1], 0)).toEqual([0]);
    expect(nextVote(poll(), [0], 0)).toEqual([]);
  });

  it("pick-any adds and takes away one at a time", () => {
    expect(nextVote(poll(true), [2], 0)).toEqual([0, 2]);
    expect(nextVote(poll(true), [0, 2], 2)).toEqual([0]);
  });

  it("finds your vote, and nobody's is nothing", () => {
    expect(votesOf(poll(), "u-matt")).toEqual([0]);
    expect(votesOf(poll(), "u-sam")).toEqual([]);
    expect(votesOf(poll(), null)).toEqual([]);
  });

  it("is open until it's closed or its time is up", () => {
    expect(pollOpen(poll(), 1_999)).toBe(true);
    expect(pollOpen(poll(), 2_000)).toBe(false);
    expect(pollOpen({ ...poll(), closed_at: 1_000 }, 1_500)).toBe(false);
  });

  it("says how it came out as the server's closed line does", () => {
    expect(resultWords(["Horde"])).toBe("Horde won.");
    expect(resultWords(["Horde", "Alliance"])).toBe("Horde and Alliance tied.");
    expect(resultWords(["PvP", "PvE", "RP"])).toBe("PvP, PvE and RP tied.");
    expect(resultWords([])).toBe("Nobody voted.");
  });
});

describe("an ask's one-time key (PROTOCOL §4, #524)", () => {
  const ask = { question: "Which night?", choices: ["Tuesday", "Thursday"], multi: false, closes_in_days: 7 };
  const fresh = () => "new-key";

  it("is new for the first press", () => {
    expect(pollNonce(null, ask, fresh)).toBe("new-key");
  });

  it("is the first press's when Post poll is pressed again with the panel as it was", () => {
    expect(pollNonce({ ask, nonce: "first-press" }, { ...ask, choices: [...ask.choices] }, fresh)).toBe("first-press");
  });

  it("is new once anything about it changed: it's another poll then", () => {
    const before = { ask, nonce: "first-press" };
    expect(pollNonce(before, { ...ask, question: "Which night, really?" }, fresh)).toBe("new-key");
    expect(pollNonce(before, { ...ask, choices: ["Thursday", "Tuesday"] }, fresh)).toBe("new-key");
    expect(pollNonce(before, { ...ask, multi: true }, fresh)).toBe("new-key");
    expect(pollNonce(before, { ...ask, closes_in_days: 14 }, fresh)).toBe("new-key");
  });
});
