/**
 * What a search result says. The cases worth writing down are the ones a
 * result list gets wrong: a hit with no words in it at all, and the three
 * different reasons the list can be empty.
 */
import { describe, expect, it } from "vitest";

import type { SearchSnippetPart } from "../generated/SearchSnippetPart";
import { emptyLine, isSearchable, snippetText } from "./search";

const runs = (...parts: [string, boolean][]): SearchSnippetPart[] =>
  parts.map(([text, matched]) => ({ text, matched }));

describe("snippetText", () => {
  it("puts the runs back together with nothing between them", () => {
    expect(
      snippetText(runs(["did the ", false], ["drive", true], [" get here yet", false])),
    ).toBe("did the drive get here yet");
  });

  it("is empty for a message that said nothing", () => {
    expect(snippetText([])).toBe("");
  });
});

describe("isSearchable", () => {
  it("takes a word", () => {
    expect(isSearchable("drive")).toBe(true);
  });

  it("takes a word with punctuation on it", () => {
    expect(isSearchable("  ...drive?  ")).toBe(true);
  });

  it("takes letters that are not English", () => {
    expect(isSearchable("привет")).toBe(true);
    expect(isSearchable("日本")).toBe(true);
  });

  it("takes a number", () => {
    expect(isSearchable("2026")).toBe(true);
  });

  // The server refuses these (`Terms::parse` returns None). Catching them here
  // means the box does not spend a rate-limit token to be told off.
  it("refuses an empty box", () => {
    expect(isSearchable("")).toBe(false);
    expect(isSearchable("   ")).toBe(false);
  });

  it("refuses pure punctuation", () => {
    expect(isSearchable("???")).toBe(false);
    expect(isSearchable('" "')).toBe(false);
  });
});

describe("emptyLine", () => {
  it("says what the box is for before anybody types", () => {
    expect(emptyLine("", false)).toMatch(/names of the files/);
  });

  it("asks for a word when there is nothing to search for", () => {
    expect(emptyLine("???", false)).toBe("Type a word to search for.");
  });

  it("says nothing matched", () => {
    expect(emptyLine("drive", false)).toBe("Nothing here matches that.");
  });

  // The difference that matters: with a filter on, "nothing" might mean
  // "nothing *there*", and the way out is to widen the filter rather than
  // pick a different word.
  it("blames the filter when there is one", () => {
    expect(emptyLine("drive", true)).toMatch(/room or from the person/);
  });
});
