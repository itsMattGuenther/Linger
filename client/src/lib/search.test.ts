/**
 * What a search result says. The cases worth writing down are the ones a
 * result list gets wrong: a hit with no words in it at all, a hit that matched
 * a filename rather than the text, and the three different reasons the list can
 * be empty.
 */
import { describe, expect, it } from "vitest";

import type { SearchHit } from "../generated/SearchHit";
import type { SearchSnippetPart } from "../generated/SearchSnippetPart";
import { emptyLine, fileLine, hitLabel, isSearchable, snippetText } from "./search";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    message_id: "m1",
    room_id: "r1",
    author_id: "u1",
    created_at: 0,
    cursor: "0189",
    snippet: [],
    matched_filenames: [],
    ...over,
  };
}

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

describe("fileLine", () => {
  it("says nothing when no filename matched", () => {
    expect(fileLine([])).toBeNull();
  });

  it("names one file", () => {
    expect(fileLine(["invoice.pdf"])).toBe("file: invoice.pdf");
  });

  it("joins two with an and", () => {
    expect(fileLine(["a.png", "b.png"])).toBe("files: a.png and b.png");
  });

  it("joins three", () => {
    expect(fileLine(["a.png", "b.png", "c.png"])).toBe("files: a.png, b.png and c.png");
  });

  it("counts the rest rather than listing them", () => {
    expect(fileLine(["a", "b", "c", "d", "e"])).toBe("files: a, b and 3 more");
  });
});

describe("hitLabel", () => {
  it("reads as a sentence: who, where, when, what", () => {
    const one = hit({ snippet: runs(["mounting it ", false], ["now", true]) });
    expect(hitLabel(one, "Matt", "#garage", "14 Mar 2026, 09:31")).toBe(
      "Matt in #garage, 14 Mar 2026, 09:31: mounting it now",
    );
  });

  it("falls back to the filename when the message had no words", () => {
    const one = hit({ snippet: [], matched_filenames: ["drive-cage.jpg"] });
    expect(hitLabel(one, "Callie", "#shop", "1 Feb 2026, 10:00")).toBe(
      "Callie in #shop, 1 Feb 2026, 10:00: file: drive-cage.jpg",
    );
  });

  it("says both when there are words and a matched filename", () => {
    const one = hit({
      snippet: runs(["here it is", false]),
      matched_filenames: ["drive-cage.jpg"],
    });
    expect(hitLabel(one, "Callie", "#shop", "when")).toBe(
      "Callie in #shop, when: here it is, file: drive-cage.jpg",
    );
  });

  it("survives a room the client has not been told about", () => {
    const one = hit({ snippet: runs(["hello", false]) });
    expect(hitLabel(one, "Matt", undefined, "when")).toBe("Matt, when: hello");
  });

  it("says so rather than nothing when there is neither", () => {
    expect(hitLabel(hit({}), "Matt", "#porch", "when")).toBe("Matt in #porch, when: no text");
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
