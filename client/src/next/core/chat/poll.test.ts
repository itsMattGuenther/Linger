import { describe, expect, it } from "vitest";
import type { Poll } from "../../../generated/Poll";
import { nextVote, pollCommand, pollOpen, resultWords, typingPoll, votesOf } from "./poll";

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
