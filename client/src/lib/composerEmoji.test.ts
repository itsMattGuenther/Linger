import { describe, expect, it } from "vitest";
import { COMPOSER_EMOJI, insertGlyph } from "./composerEmoji";

describe("insertGlyph", () => {
  it("puts the mark at the caret and leaves the rest of the draft", () => {
    expect(insertGlyph("hello", "👋", 5, 5, 8000)).toEqual({
      text: "hello👋",
      caret: 7,
    });
    expect(insertGlyph("ab", "x", 1, 1, 8000)).toEqual({
      text: "axb",
      caret: 2,
    });
  });

  it("replaces a selection", () => {
    expect(insertGlyph("hello", "!", 1, 4, 8000)).toEqual({
      text: "h!o",
      caret: 2,
    });
  });

  it("refuses when the draft would pass the ceiling", () => {
    expect(insertGlyph("ab", "👋", 2, 2, 3)).toBeNull();
  });
});

describe("COMPOSER_EMOJI", () => {
  it("is ordinary Unicode with a name for each mark", () => {
    expect(COMPOSER_EMOJI.length).toBeGreaterThan(20);
    for (const one of COMPOSER_EMOJI) {
      expect(one.glyph.length).toBeGreaterThan(0);
      expect(one.label.length).toBeGreaterThan(0);
    }
  });
});
