import { describe, expect, it } from "vitest";
import { merge, type Stream } from "./pages";

/** Items are their times; bigger is newer, and newest comes first. */
const newestFirst = (a: number, b: number) => b - a;
const stream = (items: number[], more: boolean): Stream<number> => ({ items, more });

describe("paging through several servers", () => {
  it("is ordinary paging with one server", () => {
    const merged = merge([["a", stream([9, 7, 4], true)]], newestFirst);
    expect(merged.shown.map(({ item }) => item)).toEqual([9, 7, 4]);
    expect(merged.next).toEqual(["a"]);
    expect(merged.more).toBe(true);
  });

  it("merges in the servers' own order and says where each came from", () => {
    const merged = merge(
      [
        ["a", stream([9, 5], false)],
        ["b", stream([8, 6, 1], false)],
      ],
      newestFirst,
    );
    expect(merged.shown).toEqual([
      { server: "a", item: 9 },
      { server: "b", item: 8 },
      { server: "b", item: 6 },
      { server: "a", item: 5 },
      { server: "b", item: 1 },
    ]);
    expect(merged.more).toBe(false);
    expect(merged.next).toEqual([]);
  });

  it("holds back what sorts after the last thing a server with more has sent", () => {
    // b has more: its next page is older than 6, so 5 and 2 from a must wait.
    const merged = merge(
      [
        ["a", stream([9, 5, 2], false)],
        ["b", stream([8, 6], true)],
      ],
      newestFirst,
    );
    expect(merged.shown.map(({ item }) => item)).toEqual([9, 8, 6]);
    expect(merged.next).toEqual(["b"]);
    expect(merged.more).toBe(true);
  });

  it("stops at the earliest such edge when several servers have more", () => {
    const merged = merge(
      [
        ["a", stream([9, 3], true)],
        ["b", stream([8, 6], true)],
      ],
      newestFirst,
    );
    expect(merged.shown.map(({ item }) => item)).toEqual([9, 8, 6]);
    // Only b's next page can move the edge; a's 3 is already waiting.
    expect(merged.next).toEqual(["b"]);
  });

  it("asks every server holding the edge when they tie", () => {
    const merged = merge(
      [
        ["a", stream([9, 6], true)],
        ["b", stream([8, 6], true)],
      ],
      newestFirst,
    );
    expect(merged.shown.map(({ server, item }) => `${server}${item}`)).toEqual(["a9", "b8", "a6", "b6"]);
    expect(merged.next).toEqual(["a", "b"]);
  });

  it("shows nothing while a server hasn't answered its first page", () => {
    const merged = merge(
      [
        ["a", stream([9, 5], false)],
        ["b", stream([], true)],
      ],
      newestFirst,
    );
    expect(merged.shown).toEqual([]);
    expect(merged.more).toBe(true);
    expect(merged.next).toEqual([]);
  });

  it("keeps ties in the order the servers were given", () => {
    const merged = merge(
      [
        ["b", stream([5], false)],
        ["a", stream([5], false)],
      ],
      newestFirst,
    );
    expect(merged.shown.map(({ server }) => server)).toEqual(["b", "a"]);
  });

  it("is empty and done when every server is", () => {
    expect(merge([["a", stream([], false)]], newestFirst)).toEqual({ shown: [], next: [], more: false });
  });
});
