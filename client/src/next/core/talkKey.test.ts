import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canBeTalkKey,
  DEFAULT_TALK_KEY,
  hyprlandBind,
  isMouseTalkKey,
  isTalkButton,
  isTalkKey,
  TALK_KEYS,
  talkButton,
  talkKeyName,
} from "./talkKey";

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

  it("can be the middle mouse button or a side button, never a left or right click (#500)", () => {
    expect(talkButton(1)).toBe("MouseMiddle");
    expect(talkButton(3)).toBe("MouseBack");
    expect(talkButton(4)).toBe("MouseForward");
    expect(talkButton(0)).toBeNull();
    expect(talkButton(2)).toBeNull();
    expect(isTalkButton({ button: 3 }, "MouseBack")).toBe(true);
    expect(isTalkButton({ button: 4 }, "MouseBack")).toBe(false);
    expect(isTalkButton({ button: 0 }, DEFAULT_TALK_KEY)).toBe(false);
    expect(isMouseTalkKey("MouseForward")).toBe(true);
    expect(isMouseTalkKey("ControlRight")).toBe(false);
    expect(talkKeyName("MouseBack")).toBe("Mouse 4");
    expect(talkKeyName("MouseForward")).toBe("Mouse 5");
    expect(talkKeyName("MouseMiddle")).toBe("Middle Mouse");
  });

  it("every key the picker can save is one the desktop shell knows how to watch for (#500)", () => {
    // The keyboard keys are exactly those the picker takes.
    expect(TALK_KEYS.filter((code) => !isMouseTalkKey(code)).every(canBeTalkKey)).toBe(true);
    expect(TALK_KEYS).toHaveLength(37);
    // The shell maps each to Windows' and Linux's names; a code it doesn't
    // know would leave that key working only with Linger in front.
    const here = dirname(fileURLToPath(import.meta.url));
    const shell = readFileSync(resolve(here, "../../../src-tauri/src/talk_key/mod.rs"), "utf8");
    const mapped = [...shell.matchAll(/^\s*"(\w+)" => key\(/gm)].map((found) => found[1]);
    for (const code of TALK_KEYS) {
      if (/^F\d+$/.test(code)) continue;
      expect(mapped, code).toContain(code);
    }
    expect(shell).toMatch(/\(1\.\.=24\)\.contains/);
  });

  it("gives Hyprland a bind line that lets the app in front keep the key and hears a modifier let go (#500)", () => {
    expect(hyprlandBind("lua", "Control_R", "linger:push-to-talk")).toBe(
      'hl.bind("Control_R", hl.dsp.global("linger:push-to-talk"), { non_consuming = true, ignore_mods = true })',
    );
    expect(hyprlandBind("conf", "mouse:275", "com.linger.desktop:push-to-talk")).toBe(
      "bindni = , mouse:275, global, com.linger.desktop:push-to-talk",
    );
  });
});
