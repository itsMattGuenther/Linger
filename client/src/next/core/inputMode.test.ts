import { describe, expect, it } from "vitest";
import { followInputMode } from "./inputMode";

/** A key going down, as the page sees it. */
function keyDown(key: string): Event {
  return Object.assign(new Event("keydown"), { key });
}

describe("how you last used the window, for the focus ring (#375)", () => {
  it("says nothing until the first click or key, then pointer after a click and keyboard after a key", () => {
    const root = { dataset: {} as DOMStringMap };
    const page = new EventTarget();
    followInputMode(root, page);
    expect(root.dataset.input).toBeUndefined();
    page.dispatchEvent(new Event("pointerdown"));
    expect(root.dataset.input).toBe("pointer");
    page.dispatchEvent(keyDown("Tab"));
    expect(root.dataset.input).toBe("keyboard");
    page.dispatchEvent(new Event("pointerdown"));
    expect(root.dataset.input).toBe("pointer");
    page.dispatchEvent(keyDown("a"));
    expect(root.dataset.input).toBe("keyboard");
  });

  it("a modifier on its own, the start of a desktop shortcut, changes nothing", () => {
    const root = { dataset: {} as DOMStringMap };
    const page = new EventTarget();
    followInputMode(root, page);
    page.dispatchEvent(new Event("pointerdown"));
    for (const key of ["Meta", "OS", "Super", "Shift", "Control", "Alt"]) page.dispatchEvent(keyDown(key));
    expect(root.dataset.input).toBe("pointer");
  });

  it("stops following once let go", () => {
    const root = { dataset: {} as DOMStringMap };
    const page = new EventTarget();
    const stop = followInputMode(root, page);
    stop();
    page.dispatchEvent(new Event("pointerdown"));
    expect(root.dataset.input).toBeUndefined();
  });
});
