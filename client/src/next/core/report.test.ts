import { describe, expect, it } from "vitest";
import { INPUT_EVERY_MS, type ReportTarget, startReporting } from "./report";
import type { Intent } from "./share";

function fakeWindow(focused = true) {
  const listeners = new Map<string, Set<() => void>>();
  let has = focused;
  const target: ReportTarget = {
    hasFocus: () => has,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  };
  const fire = (type: string) => listeners.get(type)?.forEach((listener) => listener());
  return {
    target,
    focus: () => {
      has = true;
      fire("focus");
    },
    blur: () => {
      has = false;
      fire("blur");
    },
    fire,
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function recorder() {
  const said: Intent[] = [];
  return { said, intend: async (intent: Intent) => void said.push(intent) };
}

describe("a chat window reporting presence to the owner", () => {
  it("says at once whether it has focus", () => {
    const { said, intend } = recorder();
    startReporting(intend, fakeWindow(true).target, () => 0);
    expect(said).toEqual([{ kind: "window", focused: true, input: true }]);
  });

  it("reports focus changes, with gaining focus counting as input", () => {
    const { said, intend } = recorder();
    const window = fakeWindow(false);
    startReporting(intend, window.target, () => 0);
    window.focus();
    window.blur();
    window.blur();
    expect(said.slice(1)).toEqual([
      { kind: "window", focused: true, input: true },
      { kind: "window", focused: false, input: false },
    ]);
  });

  it("reports typing and moving at most every fifteen seconds", () => {
    const { said, intend } = recorder();
    const window = fakeWindow(true);
    let now = 0;
    startReporting(intend, window.target, () => now);
    said.length = 0;
    for (let at = 0; at <= 60_000; at += 1_000) {
      now = at;
      window.fire(at % 2 === 0 ? "keydown" : "pointermove");
    }
    // The first report counts; then one every INPUT_EVERY_MS at most.
    expect(said.length).toBe(Math.floor(60_000 / INPUT_EVERY_MS) + 1);
    expect(said.every((intent) => intent.kind === "window" && intent.input)).toBe(true);
  });

  it("says which conversation it shows, only when that changes", () => {
    const { said, intend } = recorder();
    const reporter = startReporting(intend, fakeWindow(true).target, () => 0);
    said.length = 0;
    reporter.showing("https://home.example", "r-general");
    reporter.showing("https://home.example", "r-general");
    reporter.showing("https://home.example", "d-jules");
    reporter.showing("https://home.example", null);
    expect(said).toEqual([
      { kind: "room", server: "https://home.example", roomId: "r-general" },
      { kind: "room", server: "https://home.example", roomId: "d-jules" },
      { kind: "room", server: "https://home.example", roomId: null },
    ]);
  });

  it("says it is closing and stops listening", () => {
    const { said, intend } = recorder();
    const window = fakeWindow(true);
    const reporter = startReporting(intend, window.target, () => 0);
    reporter.stop();
    expect(said.at(-1)).toEqual({ kind: "closing" });
    expect(window.count()).toBe(0);
  });
});
