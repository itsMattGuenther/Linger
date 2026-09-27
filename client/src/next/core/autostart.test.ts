import { beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  desktop: true,
  calls: [] as { cmd: string; args: unknown }[],
  answer: (_cmd: string, _args: unknown): unknown => null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => shell.desktop,
  invoke: async (cmd: string, args?: unknown) => {
    shell.calls.push({ cmd, args });
    return shell.answer(cmd, args);
  },
}));

import { ignoredLine, refusal, setStartsAtSignIn, startsAtSignIn, unanswered } from "./autostart";

beforeEach(() => {
  shell.desktop = true;
  shell.calls = [];
  shell.answer = () => null;
});

describe("starting Linger at sign-in (#228)", () => {
  it("asks the computer, and says what it answers", async () => {
    shell.answer = () => ({ on: false, ignored_by: null });
    expect(await startsAtSignIn()).toEqual({ on: false, ignored_by: null });
    shell.answer = () => ({ on: true, ignored_by: "Hyprland" });
    expect(await startsAtSignIn()).toEqual({ on: true, ignored_by: "Hyprland" });
    expect(shell.calls.map((call) => call.cmd)).toEqual(["autostart_state", "autostart_state"]);
  });

  it("isn't offered where the computer says so, or outside the desktop app", async () => {
    shell.answer = () => null;
    expect(await startsAtSignIn()).toBeNull();
    shell.desktop = false;
    expect(await startsAtSignIn()).toBeNull();
    // A browser never asks.
    expect(shell.calls).toHaveLength(1);
  });

  it("turns it on and off, and resolves to the computer's answer", async () => {
    shell.answer = (_cmd, args) => ({ on: (args as { on: boolean }).on, ignored_by: null });
    expect(await setStartsAtSignIn(true)).toEqual({ on: true, ignored_by: null });
    expect(await setStartsAtSignIn(false)).toEqual({ on: false, ignored_by: null });
    expect(shell.calls).toEqual([
      { cmd: "autostart_set", args: { on: true } },
      { cmd: "autostart_set", args: { on: false } },
    ]);
  });

  it("says a refusal in plain words", () => {
    expect(refusal(true, "This computer didn't allow it.")).toBe("Couldn't turn this on. This computer didn't allow it.");
    expect(refusal(false, "This computer said: the disk is full.")).toBe("Couldn't turn this off. This computer said: the disk is full.");
    // Anything that isn't the shell's sentence gets no reason, not a stack trace.
    expect(refusal(true, new Error("invoke failed at line 3"))).toBe("Couldn't turn this on.");
    expect(refusal(true, "  ")).toBe("Couldn't turn this on.");
    expect(unanswered("This computer didn't allow it.")).toBe("Couldn't find out whether Linger starts when you sign in. This computer didn't allow it.");
    expect(unanswered(undefined)).toBe("Couldn't find out whether Linger starts when you sign in.");
  });

  it("names a desktop that won't start it by itself", () => {
    expect(ignoredLine("Hyprland")).toMatch(/^Hyprland doesn't start apps from the usual startup list by itself/);
    expect(ignoredLine("")).toMatch(/^This desktop doesn't/);
  });
});
