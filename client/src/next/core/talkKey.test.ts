import { describe, expect, it } from "vitest";
import { canBeTalkKey, DEFAULT_TALK_KEY, isTalkKey, talkKeyName } from "./talkKey";

describe("the push-to-talk key", () => {
  it("is Right Ctrl unless somebody picks another, which the shortcuts' Left Ctrl isn't", () => {
    expect(DEFAULT_TALK_KEY).toBe("ControlRight");
    expect(isTalkKey({ code: "ControlRight" }, DEFAULT_TALK_KEY)).toBe(true);
    expect(isTalkKey({ code: "ControlLeft" }, DEFAULT_TALK_KEY)).toBe(false);
  });

  it("can only be a key that types nothing", () => {
    for (const code of ["ControlRight", "AltLeft", "ShiftRight", "F13", "F24", "Pause", "ScrollLock", "Insert", "ContextMenu"]) {
      expect(canBeTalkKey(code)).toBe(true);
    }
    for (const code of ["KeyV", "Digit1", "Space", "Enter", "Tab", "Escape", "CapsLock", "Backquote", "F25", "MetaLeft"]) {
      expect(canBeTalkKey(code)).toBe(false);
    }
  });

  it("is named as a person would say it", () => {
    expect(talkKeyName("ControlRight")).toBe("Right Ctrl");
    expect(talkKeyName("AltLeft")).toBe("Left Alt");
    expect(talkKeyName("ShiftRight")).toBe("Right Shift");
    expect(talkKeyName("F13")).toBe("F13");
    expect(talkKeyName("ScrollLock")).toBe("Scroll Lock");
  });
});
