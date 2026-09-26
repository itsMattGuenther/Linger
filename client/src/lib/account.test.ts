import { describe, expect, it } from "vitest";

import {
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
