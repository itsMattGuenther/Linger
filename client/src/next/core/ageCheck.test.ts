import { describe, expect, it, vi } from "vitest";
import { ageCheck, verdictOf } from "./ageCheck";

describe("the phone's age check (#953)", () => {
  it("counts only the shell's exact child as one", () => {
    expect(verdictOf("child")).toBe("child");
    for (const answer of ["ok", "CHILD", "", null, undefined, 12, { child: true }]) {
      expect(verdictOf(answer)).toBe("ok");
    }
  });

  it("starts ok, and a child answer closes it and tells whoever listens", async () => {
    const check = ageCheck();
    const heard = vi.fn();
    check.subscribe(heard);
    expect(check.verdict()).toBe("ok");
    await check.ask(async () => "child");
    expect(check.verdict()).toBe("child");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays ok when the check fails, throws or says anything else", async () => {
    for (const question of [
      async () => "ok",
      async () => null,
      async () => {
        throw new Error("no store");
      },
      () => {
        throw new Error("thrown before a promise");
      },
    ]) {
      const check = ageCheck();
      const heard = vi.fn();
      check.subscribe(heard);
      await check.ask(question);
      expect(check.verdict()).toBe("ok");
      expect(heard).not.toHaveBeenCalled();
    }
  });

  it("asks the shell once, however often the page asks", async () => {
    const check = ageCheck();
    const question = vi.fn(async () => "ok");
    await Promise.all([check.ask(question), check.ask(question)]);
    await check.ask(question);
    expect(question).toHaveBeenCalledTimes(1);
  });

  it("stops telling a listener that has gone", async () => {
    const check = ageCheck();
    const heard = vi.fn();
    check.subscribe(heard)();
    await check.ask(async () => "child");
    expect(heard).not.toHaveBeenCalled();
  });
});
