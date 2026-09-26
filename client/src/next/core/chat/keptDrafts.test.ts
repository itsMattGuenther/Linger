import { describe, expect, it } from "vitest";
import { KEEP_MS, keepDraft, keptDraft, MAX_KEPT } from "./keptDrafts";

function memory() {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

describe("kept drafts", () => {
  it("keep a conversation's half-typed line, and let it go once it's empty", () => {
    const store = memory();
    keepDraft(store, "a#r-general", "see you at", 1_000);
    expect(keptDraft(store, "a#r-general", 2_000)).toBe("see you at");
    expect(keptDraft(store, "a#r-other", 2_000)).toBe("");
    keepDraft(store, "a#r-general", "   ", 3_000);
    expect(keptDraft(store, "a#r-general", 4_000)).toBe("");
    expect(store.held.size).toBe(0);
  });

  it("let a draft untouched for a month go, and keep only the newest hundred", () => {
    const store = memory();
    keepDraft(store, "old", "from ages ago", 0);
    expect(keptDraft(store, "old", KEEP_MS + 1)).toBe("");
    for (let n = 0; n <= MAX_KEPT; n++) keepDraft(store, `c${n}`, `draft ${n}`, 10 + n);
    expect(keptDraft(store, "c0", 1_000)).toBe("");
    expect(keptDraft(store, `c${MAX_KEPT}`, 1_000)).toBe(`draft ${MAX_KEPT}`);
  });

  it("survive storage that refuses or holds nonsense", () => {
    const store = memory();
    store.held.set("linger.next.drafts", "not json");
    expect(keptDraft(store, "a", 0)).toBe("");
    const refusing = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => undefined };
    expect(() => keepDraft(refusing, "a", "hello", 0)).not.toThrow();
  });
});
