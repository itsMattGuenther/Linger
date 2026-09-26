import { describe, expect, it } from "vitest";
import { isMode, loadMode, type ModeStore, saveMode } from "./conversations";

function memory(): ModeStore {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

describe("how conversations open", () => {
  it("is tabs until windows is chosen, and remembers the choice", () => {
    const store = memory();
    expect(loadMode(store)).toBe("tabs");
    saveMode(store, "windows");
    expect(loadMode(store)).toBe("windows");
    saveMode(store, "tabs");
    expect(loadMode(store)).toBe("tabs");
  });

  it("falls back to tabs when storage is missing, refuses, or holds something else", () => {
    expect(loadMode(null)).toBe("tabs");
    const refusing: ModeStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadMode(refusing)).toBe("tabs");
    expect(() => saveMode(refusing, "windows")).not.toThrow();
    const odd = memory();
    odd.setItem("linger.next.conversations", "Windows");
    expect(loadMode(odd)).toBe("tabs");
  });

  it("checks a choice before trusting it", () => {
    expect(isMode("tabs")).toBe(true);
    expect(isMode("windows")).toBe(true);
    for (const junk of ["", "window", null, 1, {}]) expect(isMode(junk)).toBe(false);
  });
});
