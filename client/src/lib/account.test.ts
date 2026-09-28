import { describe, expect, it } from "vitest";

import {
  displayNameProblem,
  displayNameReady,
  displayNameRequest,
  MAX_DISPLAY_NAME_CHARS,
  MIN_PASSWORD_CHARS,
  passwordReady,
  passwordRequest,
} from "./account";

describe("displayNameRequest", () => {
  it("only sends the name, so a save cannot wipe a status", () => {
    expect(displayNameRequest("  Matt  ")).toEqual({
      display_name: "Matt",
      style: null,
      status: null,
      entrance_sound: null,
    });
  });
});

describe("displayNameReady", () => {
  it("refuses a no-op, a blank, and anything over the cap", () => {
    expect(displayNameReady("Matt", "Matt")).toBe(false);
    expect(displayNameReady("  Matt  ", "Matt")).toBe(false);
    expect(displayNameReady("", "Matt")).toBe(false);
    expect(displayNameReady("x".repeat(MAX_DISPLAY_NAME_CHARS + 1), "Matt")).toBe(false);
    expect(displayNameReady("Callie", "Matt")).toBe(true);
  });

  it("counts characters the way the server does, so 32 emoji fit", () => {
    expect(displayNameReady("💾".repeat(MAX_DISPLAY_NAME_CHARS), "Matt")).toBe(true);
    expect(displayNameReady("💾".repeat(MAX_DISPLAY_NAME_CHARS + 1), "Matt")).toBe(false);
  });

  it("refuses a name the server would refuse (#296)", () => {
    expect(displayNameReady("Ma\u{200B}tt", "Matt")).toBe(false);
    expect(displayNameReady("\u{3164}", "Matt")).toBe(false);
    expect(displayNameReady("Zoë 👨‍👩‍👧", "Matt")).toBe(true);
  });
});

describe("displayNameProblem", () => {
  const CONTROL = "Names can't have tabs, line breaks or other control characters.";
  const DIRECTION = "Names can't have characters that change the direction of text.";
  const INVISIBLE = "Names can't have invisible characters.";
  const ACCENTS = "Names can't have more than two accent marks on one letter.";
  const MARKS = "Names can't stack that many marks on one letter.";
  const UNSEEN = "That name has no letters anyone can see.";

  it("lets real names through, in any script, with emoji", () => {
    for (const name of [
      "Justin B",
      "José",
      "Zoë",
      "李小龍",
      "محمد",
      "Ωmega",
      // Two accents written as their own characters, as Vietnamese can be.
      "Nguye\u{0302}\u{0303}n",
      "👨‍👩‍👧",
      "👩🏽‍💻 Callie",
      "🏳️‍🌈",
      "1️⃣",
      // The flag of England: 🏴 and its tag characters.
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
      // Persian, with a non-joiner inside the word.
      "\u{0639}\u{0644}\u{06CC}\u{200C}\u{0631}\u{0636}\u{0627}",
      // Sinhala "Sri", with a joiner inside it.
      "\u{0DC1}\u{0DCA}\u{200D}\u{0DBB}\u{0DD3}",
      // Tibetan "Dolma": three marks stacked on one letter.
      "\u{0F66}\u{0F92}\u{0FB2}\u{0F7C}\u{0F63}\u{0F0B}\u{0F58}",
      "Matt\u{3164}B",
    ]) {
      expect(displayNameProblem(name), name).toBeNull();
    }
    expect(displayNameProblem("")).toBeNull();
  });

  it("says why a name is refused, in the server's words", () => {
    expect(displayNameProblem("x".repeat(MAX_DISPLAY_NAME_CHARS + 1))).toBe("Display names are 1–32 characters.");
    expect(displayNameProblem("Matt\tB")).toBe(CONTROL);
    expect(displayNameProblem("Matt\nB")).toBe(CONTROL);
    expect(displayNameProblem("Matt\u{2028}B")).toBe(CONTROL);
    expect(displayNameProblem("\u{202E}ttaM")).toBe(DIRECTION);
    expect(displayNameProblem("Matt\u{2066}B\u{2069}")).toBe(DIRECTION);
    expect(displayNameProblem("Matt\u{200E}")).toBe(DIRECTION);
    expect(displayNameProblem("Ma\u{200B}tt")).toBe(INVISIBLE);
    expect(displayNameProblem("Ma\u{200D}tt")).toBe(INVISIBLE);
    expect(displayNameProblem("Ma\u{200C}tt")).toBe(INVISIBLE);
    expect(displayNameProblem("Matt\u{2060}")).toBe(INVISIBLE);
    expect(displayNameProblem("Ma\u{00AD}tt")).toBe(INVISIBLE);
    expect(displayNameProblem("Matt1\u{200D}2")).toBe(INVISIBLE);
    expect(displayNameProblem("💾\u{200D}")).toBe(INVISIBLE);
    expect(displayNameProblem("Matt\u{E0067}")).toBe(INVISIBLE);
    expect(displayNameProblem("a\u{0301}\u{0302}")).toBeNull();
    expect(displayNameProblem("a\u{0301}\u{0302}\u{0303}")).toBe(ACCENTS);
    expect(displayNameProblem("\u{0E01}\u{0E49}\u{0E49}\u{0E49}\u{0E49}")).toBeNull();
    expect(displayNameProblem("\u{0E01}\u{0E49}\u{0E49}\u{0E49}\u{0E49}\u{0E49}")).toBe(MARKS);
    expect(displayNameProblem("   ")).toBe(UNSEEN);
    expect(displayNameProblem("\u{3164}")).toBe(UNSEEN);
    expect(displayNameProblem("\u{2800}\u{2800}")).toBe(UNSEEN);
    expect(displayNameProblem("\u{115F}\u{1160} \u{FFA0}")).toBe(UNSEEN);
    expect(displayNameProblem("\u{0301}")).toBe(UNSEEN);
  });
});

describe("passwordReady", () => {
  it("needs a current password, a long-enough new one, and a change", () => {
    expect(passwordReady("", "long enough")).toBe(false);
    expect(passwordReady("old-password", "short")).toBe(false);
    expect(passwordReady("same-password", "same-password")).toBe(false);
    expect(passwordReady("old-password", "a".repeat(MIN_PASSWORD_CHARS))).toBe(true);
  });
});

describe("passwordRequest", () => {
  it("matches the generated wire type field names", () => {
    expect(passwordRequest("old", "new-password")).toEqual({
      current_password: "old",
      new_password: "new-password",
    });
  });
});
