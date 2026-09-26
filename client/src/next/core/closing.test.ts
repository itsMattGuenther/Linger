import { describe, expect, it } from "vitest";
import { loadCloseList, saveCloseList } from "./closing";

function memory() {
  const held = new Map<string, string>();
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) };
}

describe("what closing the list does", () => {
  it("keeps Linger in the tray unless told to quit, and remembers the choice", () => {
    const store = memory();
    expect(loadCloseList(store)).toBe("tray");
    expect(loadCloseList(null)).toBe("tray");
    saveCloseList(store, "quit");
    expect(loadCloseList(store)).toBe("quit");
    saveCloseList(store, "tray");
    expect(loadCloseList(store)).toBe("tray");
  });

  it("reads anything else as the tray, and survives storage that refuses", () => {
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(loadCloseList(broken)).toBe("tray");
    expect(() => saveCloseList(broken, "quit")).not.toThrow();
    const odd = memory();
    odd.setItem("linger.next.closeList", "sideways");
    expect(loadCloseList(odd)).toBe("tray");
  });
});
