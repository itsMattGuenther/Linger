import { describe, expect, it } from "vitest";
import { foldMotd, MAX_FOLDS, motdCommand, motdFolded, typingMotd } from "./motd";

function memoryStore(): Storage {
  const held = new Map<string, string>();
  return {
    get length() {
      return held.size;
    },
    clear: () => held.clear(),
    getItem: (key) => held.get(key) ?? null,
    key: (index) => [...held.keys()][index] ?? null,
    removeItem: (key) => void held.delete(key),
    setItem: (key, value) => void held.set(key, value),
  };
}

describe("motdCommand", () => {
  it("reads the message after /motd, trimmed", () => {
    expect(motdCommand("/motd We meet Friday at 8")).toBe("We meet Friday at 8");
    expect(motdCommand("  /motd   We meet Friday  ")).toBe("We meet Friday");
    expect(motdCommand("/MOTD loud")).toBe("loud");
    expect(motdCommand("/motd\nOn a new line")).toBe("On a new line");
  });

  it("reads /motd on its own as clearing it", () => {
    expect(motdCommand("/motd")).toBe("");
    expect(motdCommand("/motd   ")).toBe("");
  });

  it("leaves everything else an ordinary message", () => {
    expect(motdCommand("motd is a good idea")).toBeNull();
    expect(motdCommand("/motdx hello")).toBeNull();
    expect(motdCommand("/shrug")).toBeNull();
    expect(motdCommand("see /motd")).toBeNull();
    expect(motdCommand("")).toBeNull();
  });
});

describe("typingMotd", () => {
  it("is on from /m, while the word could still become /motd", () => {
    expect(typingMotd("/")).toBe(false);
    expect(typingMotd("/m")).toBe(true);
    expect(typingMotd("/mot")).toBe(true);
    expect(typingMotd("/motd")).toBe(true);
    expect(typingMotd("/motd We meet")).toBe(true);
  });

  it("is off for anything else", () => {
    expect(typingMotd("/shrug")).toBe(false);
    expect(typingMotd("/mo hello")).toBe(false);
    expect(typingMotd("/motdx")).toBe(false);
    expect(typingMotd("hello")).toBe(false);
  });
});

describe("folding", () => {
  it("is kept by the moment the message was set, so a new one opens again", () => {
    const store = memoryStore();
    expect(motdFolded(store, "a#general", 100)).toBe(false);
    foldMotd(store, "a#general", 100, true);
    expect(motdFolded(store, "a#general", 100)).toBe(true);
    // Somebody set a new one.
    expect(motdFolded(store, "a#general", 200)).toBe(false);
    // Each room is its own.
    expect(motdFolded(store, "a#raid", 100)).toBe(false);
  });

  it("opens again, and forgets the room once nothing is folded", () => {
    const store = memoryStore();
    foldMotd(store, "a#general", 100, true);
    foldMotd(store, "a#general", 100, false);
    expect(motdFolded(store, "a#general", 100)).toBe(false);
    expect(store.length).toBe(0);
  });

  it("keeps the newest folds only", () => {
    const store = memoryStore();
    for (let room = 0; room <= MAX_FOLDS; room += 1) foldMotd(store, `a#${room}`, 1, true);
    expect(motdFolded(store, "a#0", 1)).toBe(false);
    expect(motdFolded(store, `a#${MAX_FOLDS}`, 1)).toBe(true);
  });

  it("does nothing, and never throws, without storage", () => {
    expect(() => foldMotd(null, "a#general", 1, true)).not.toThrow();
    expect(motdFolded(null, "a#general", 1)).toBe(false);
    const broken = { getItem: () => "not json", setItem: () => { throw new Error("full"); }, removeItem: () => undefined };
    expect(() => foldMotd(broken, "a#general", 1, true)).not.toThrow();
    expect(motdFolded(broken, "a#general", 1)).toBe(false);
  });
});
