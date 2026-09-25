import { describe, expect, it } from "vitest";
import { isSettingsKey, type KeyPress, tabCommand } from "./keys";

function press(key: string, held: Partial<Omit<KeyPress, "key">> = {}): KeyPress {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...held };
}

describe("the Settings shortcut", () => {
  it("is Ctrl+comma, and nothing else", () => {
    expect(isSettingsKey(press(",", { ctrlKey: true }))).toBe(true);
    for (const other of [press(","), press(",", { ctrlKey: true, shiftKey: true }), press(",", { ctrlKey: true, altKey: true }), press(".", { ctrlKey: true })]) {
      expect(isSettingsKey(other)).toBe(false);
    }
    // And it is never mistaken for a tab command.
    expect(tabCommand(press(",", { ctrlKey: true }))).toBeNull();
  });
});

describe("the chat window's tab shortcuts", () => {
  it("steps through tabs with Ctrl+Tab and Ctrl+PageDown, backwards with Shift or PageUp", () => {
    expect(tabCommand(press("Tab", { ctrlKey: true }))).toEqual({ kind: "step", by: 1 });
    expect(tabCommand(press("Tab", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "step", by: -1 });
    expect(tabCommand(press("PageDown", { ctrlKey: true }))).toEqual({ kind: "step", by: 1 });
    expect(tabCommand(press("PageUp", { ctrlKey: true }))).toEqual({ kind: "step", by: -1 });
  });

  it("moves the showing tab along the row with Ctrl+Shift+PageDown and PageUp", () => {
    expect(tabCommand(press("PageDown", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "move", by: 1 });
    expect(tabCommand(press("PageUp", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "move", by: -1 });
  });

  it("closes the showing tab with Ctrl+W, with Caps Lock on too", () => {
    expect(tabCommand(press("w", { ctrlKey: true }))).toEqual({ kind: "close" });
    expect(tabCommand(press("W", { ctrlKey: true }))).toEqual({ kind: "close" });
    // Ctrl+Shift+W is the desktop's, not a tab's.
    expect(tabCommand(press("W", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("jumps with Alt and a digit, and Alt+9 is always the last tab", () => {
    expect(tabCommand(press("1", { altKey: true }))).toEqual({ kind: "jump", to: 0 });
    expect(tabCommand(press("8", { altKey: true }))).toEqual({ kind: "jump", to: 7 });
    expect(tabCommand(press("9", { altKey: true }))).toEqual({ kind: "jump", to: "last" });
    expect(tabCommand(press("0", { altKey: true }))).toBeNull();
  });

  it("leaves everything else alone: plain keys, typing, and other modifiers", () => {
    for (const other of [
      press("Tab"),
      press("w"),
      press("1"),
      press("Tab", { altKey: true }),
      press("Tab", { ctrlKey: true, altKey: true }),
      press("1", { ctrlKey: true }),
      press("1", { altKey: true, shiftKey: true }),
      press("w", { metaKey: true, ctrlKey: true }),
      press("Control", { ctrlKey: true }),
    ]) {
      expect(tabCommand(other)).toBeNull();
    }
  });
});
