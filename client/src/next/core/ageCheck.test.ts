import { describe, expect, it, vi } from "vitest";
import { ageCheck, type LeaveShell, signOutEverywhere, verdictOf } from "./ageCheck";

describe("the phone's age check (#953)", () => {
  it("counts only the shell's exact child as one", () => {
    expect(verdictOf("child")).toBe("child");
    for (const answer of ["ok", "CHILD", "", null, undefined, 12, { child: true }]) {
      expect(verdictOf(answer)).toBe("ok");
    }
  });

  it("is unknown until it answers, then child or ok, telling whoever listens", async () => {
    const child = ageCheck();
    const heard = vi.fn();
    child.subscribe(heard);
    expect(child.state()).toBe("unknown");
    await child.ask(async () => "child");
    expect(child.state()).toBe("child");
    expect(heard).toHaveBeenCalledTimes(1);

    const other = ageCheck();
    await other.ask(async () => "ok");
    expect(other.state()).toBe("ok");
  });

  it("is ok when the check fails, throws or says anything else", async () => {
    for (const question of [
      async () => null,
      async () => {
        throw new Error("no store");
      },
      () => {
        throw new Error("thrown before a promise");
      },
    ]) {
      const check = ageCheck();
      await check.ask(question);
      expect(check.state()).toBe("ok");
    }
  });

  it("giving up on the wait is ok for now, and a child's answer after it still counts", async () => {
    const check = ageCheck();
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise((settle) => (answer = settle));
    const asked = check.ask(() => pending);
    check.giveUp();
    expect(check.state()).toBe("ok");
    answer("child");
    await asked;
    expect(check.state()).toBe("child");
  });

  it("giving up changes nothing once it has answered", async () => {
    const check = ageCheck();
    await check.ask(async () => "child");
    check.giveUp();
    expect(check.state()).toBe("child");
  });

  it("asks the shell once, however often the page asks", async () => {
    const check = ageCheck();
    const question = vi.fn(async () => "ok");
    await Promise.all([check.ask(question), check.ask(question)]);
    await check.ask(question);
    expect(question).toHaveBeenCalledTimes(1);
  });

  it("signs a child out once, however often it's asked to", async () => {
    const check = ageCheck();
    const signOut = vi.fn(async () => undefined);
    await Promise.all([check.leave(signOut), check.leave(signOut)]);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("signing a child out of everything (#953)", () => {
  function shell(overrides: Partial<LeaveShell> = {}) {
    const did: string[] = [];
    const base: LeaveShell = {
      saved: async () => [
        { baseUrl: "https://a.example", refreshToken: "ra" },
        { baseUrl: "https://down.example", refreshToken: "rd" },
      ],
      logout: async (baseUrl, token) => {
        did.push(`logout ${baseUrl} ${token}`);
        if (baseUrl === "https://down.example") throw new Error("unreachable");
      },
      forget: async (baseUrl) => void did.push(`forget ${baseUrl}`),
      shareKept: async () => ["https://a.example"],
      shareForget: async (baseUrl) => (did.push(`share-forget ${baseUrl}`), "sa"),
      shareListClear: async () => void did.push("share-list-clear"),
    };
    return { did, shell: { ...base, ...overrides } };
  }

  it("forgets each sign-in here before its server is told, a server that doesn't answer too", async () => {
    const { did, shell: leave } = shell();
    await signOutEverywhere(leave);
    expect(did.indexOf("forget https://a.example")).toBeLessThan(did.indexOf("logout https://a.example ra"));
    expect(did.indexOf("forget https://down.example")).toBeLessThan(did.indexOf("logout https://down.example rd"));
    expect(did.indexOf("share-forget https://a.example")).toBeLessThan(did.indexOf("logout https://a.example sa"));
    expect(did).toContain("share-list-clear");
  });

  it("tells the servers even when the share window's steps never finish", async () => {
    const { did, shell: leave } = shell({ shareKept: () => new Promise<null>(() => undefined), shareListClear: () => new Promise<void>(() => undefined) });
    void signOutEverywhere(leave);
    await expect.poll(() => did).toEqual(expect.arrayContaining(["logout https://a.example ra", "logout https://down.example rd"]));
  });

  it("forgets everything here even when no server ever answers", async () => {
    const { did, shell: leave } = shell({ logout: () => new Promise<void>(() => undefined) });
    void signOutEverywhere(leave);
    const here = ["forget https://a.example", "forget https://down.example", "share-forget https://a.example", "share-list-clear"];
    await expect.poll(() => [...did].sort()).toEqual([...here].sort());
  });

  it("goes on through every failure: no saved sign-ins to read, no share window", async () => {
    const { did, shell: leave } = shell({
      saved: async () => {
        throw new Error("no keyring");
      },
      shareKept: async () => null,
    });
    await expect(signOutEverywhere(leave)).resolves.toBeUndefined();
    expect(did).toEqual(["share-list-clear"]);
  });
});
