import { describe, expect, it } from "vitest";
import { loadDmAlerts, saveDmAlerts } from "./dmAlerts";

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const held = new Map<string, string>();
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
}

describe("DM alerts (#291)", () => {
  it("are on until somebody turns them off", () => {
    expect(loadDmAlerts(memory())).toBe(true);
    expect(loadDmAlerts(null)).toBe(true);
  });

  it("keep the choice", () => {
    const store = memory();
    saveDmAlerts(store, false);
    expect(loadDmAlerts(store)).toBe(false);
    saveDmAlerts(store, true);
    expect(loadDmAlerts(store)).toBe(true);
  });

  it("are on when storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(loadDmAlerts(refusing)).toBe(true);
    expect(() => saveDmAlerts(refusing, false)).not.toThrow();
  });
});
