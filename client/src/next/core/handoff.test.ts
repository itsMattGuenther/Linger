import { describe, expect, it } from "vitest";
import { type DraftStore, HANDOFF_MS, leaveDraft, takeDraft } from "./handoff";

function memory(): DraftStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const GENERAL = "https://home.example#r-general";
const NOW = 1_000_000;

describe("a draft moving with its conversation between windows", () => {
  it("arrives once, in the conversation it left", () => {
    const store = memory();
    leaveDraft(store, GENERAL, "half a thought", NOW);
    expect(takeDraft(store, "https://home.example#r-plans", NOW)).toBeNull();
    expect(takeDraft(store, GENERAL, NOW + 500)).toBe("half a thought");
    expect(takeDraft(store, GENERAL, NOW + 600)).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it("an empty box leaves nothing, and clears an older draft", () => {
    const store = memory();
    leaveDraft(store, GENERAL, "old", NOW);
    leaveDraft(store, GENERAL, "   ", NOW + 1);
    expect(store.items.size).toBe(0);
  });

  it("a draft nobody took in time is thrown away, not delivered late", () => {
    const store = memory();
    leaveDraft(store, GENERAL, "too late", NOW);
    expect(takeDraft(store, GENERAL, NOW + HANDOFF_MS + 1)).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it("ignores anything malformed, and a storage that refuses", () => {
    const store = memory();
    for (const junk of ["{", "null", '{"text":1,"at":1}', '{"text":"x"}', `{"text":"x","at":${NOW + HANDOFF_MS * 5}}`]) {
      store.items.set(`linger.next.handoff.${GENERAL}`, junk);
      expect(takeDraft(store, GENERAL, NOW)).toBeNull();
    }
    const refusing: DraftStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => leaveDraft(refusing, GENERAL, "x", NOW)).not.toThrow();
    expect(takeDraft(refusing, GENERAL, NOW)).toBeNull();
  });
});
