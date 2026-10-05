import { describe, expect, it } from "vitest";
import rows from "./data";
import { GROUPS, indexOf, searchEmoji, shortcodeOf, withTone } from "./index";
import { completeShortcode, putShortcode, shortcodeAt, shortcodeCanStart } from "./shortcodes";

// The real list, as the app loads it.
const index = indexOf(rows);
const glyphOf = (name: string) => index.byShortcode.get(name)?.glyph ?? null;

describe("the emoji list (#359)", () => {
  it("has every emoji Unicode has, in groups the picker shows", () => {
    expect(index.all.length).toBeGreaterThan(1800);
    const groups = new Set(GROUPS.map((group) => group.id));
    expect(index.all.every((emoji) => groups.has(emoji.group))).toBe(true);
    for (const group of GROUPS) expect(index.all.some((emoji) => emoji.group === group.id), group.label).toBe(true);
  });

  it("finds an emoji by Discord's name for it, and by GitHub's and Slack's", () => {
    expect(glyphOf("smiley")).toBe("😃");
    expect(glyphOf("slight_smile")).toBe("🙂");
    expect(glyphOf("slightly_smiling_face")).toBe("🙂");
    expect(glyphOf("thumbsup")).toBe("👍");
    expect(glyphOf("+1")).toBe("👍");
    expect(glyphOf("joy")).toBe("😂");
    expect(glyphOf("rofl")).toBe("🤣");
    expect(glyphOf("heart")).toBe("❤️");
    expect(glyphOf("fire")).toBe("🔥");
    expect(glyphOf("upside_down")).toBe("🙃");
    expect(shortcodeOf(index.byShortcode.get("slightly_smiling_face")!)).toBe("slight_smile");
  });

  it("gives every emoji a shortcode", () => {
    expect(index.all.filter((emoji) => emoji.shortcodes.length === 0)).toEqual([]);
  });

  it("puts a skin tone on an emoji that has them, and leaves the rest", () => {
    const wave = index.byShortcode.get("wave")!;
    expect(withTone(wave, 0)).toBe("👋");
    expect(withTone(wave, 1)).toBe("👋🏻");
    expect(withTone(wave, 5)).toBe("👋🏿");
    expect(withTone(index.byShortcode.get("fire")!, 3)).toBe("🔥");
    expect(index.byGlyph.get("👋🏽")).toBe(wave);
  });

  it("searches shortcodes first, then names and words", () => {
    const found = searchEmoji(index.all, "smile").map((emoji) => shortcodeOf(emoji));
    expect(found[0]).toBe("smile");
    expect(found.slice(0, 8)).toContain("smiley");
    expect(searchEmoji(index.all, "hello").map((emoji) => emoji.glyph)).toContain("👋");
    expect(searchEmoji(index.all, ":thumbsup:")[0]?.glyph).toBe("👍");
    expect(searchEmoji(index.all, "  ")).toEqual([]);
    expect(searchEmoji(index.all, "heart", 5)).toHaveLength(5);
  });
});

describe("shortcodes in the message box (#359)", () => {
  it("offers emoji after a colon and two characters, at the start of a word", () => {
    expect(shortcodeAt(":sm", 3)).toEqual({ start: 0, end: 3, query: "sm" });
    expect(shortcodeAt("hi :Smi", 7)).toEqual({ start: 3, end: 7, query: "smi" });
    expect(shortcodeAt("hi :s", 5)).toBeNull();
    expect(shortcodeAt("at 12:30", 8)).toBeNull();
    expect(shortcodeAt("see http://x", 12)).toBeNull();
    expect(shortcodeAt("(:+1", 4)).toEqual({ start: 1, end: 4, query: "+1" });
    // The word runs on past the caret: choosing replaces all of it.
    expect(shortcodeAt(":smiling now", 4)).toEqual({ start: 0, end: 8, query: "smi" });
    expect(shortcodeCanStart("a:b", 1)).toBe(false);
  });

  it("turns a finished :smiley: into 😃 as it's typed, and leaves the rest alone", () => {
    expect(completeShortcode("great :smiley:", 14, glyphOf)).toEqual({ text: "great 😃", caret: 8 });
    expect(completeShortcode(":fire: and :fire:", 17, glyphOf)).toEqual({ text: ":fire: and 🔥", caret: 13 });
    // A server's own emoji stays its name; so does anything unknown, and a time.
    expect(completeShortcode("hi :party_parrot:", 17, glyphOf)).toBeNull();
    expect(completeShortcode("at 12:30:", 9, glyphOf)).toBeNull();
    expect(completeShortcode("::", 2, glyphOf)).toBeNull();
  });

  it("puts in a chosen emoji with a space, unless one follows", () => {
    expect(putShortcode("hi :smi", { start: 3, end: 7, query: "smi" }, "😄", 100)).toEqual({ text: "hi 😄 ", caret: 6 });
    expect(putShortcode("hi :smi there", { start: 3, end: 7, query: "smi" }, ":party_parrot:", 100)).toEqual({
      text: "hi :party_parrot: there",
      caret: 17,
    });
    expect(putShortcode("hi :smi", { start: 3, end: 7, query: "smi" }, "😄", 5)).toBeNull();
  });
});
