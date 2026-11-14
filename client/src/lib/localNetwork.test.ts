import { afterEach, describe, expect, it, vi } from "vitest";

import { ANSWER_EVENT, askAboutLocalNetwork, reachLocal, resetLocalNetwork } from "./localNetwork";

/** A phone that answers as told, and writes down what it was asked. */
function phone(answers: Record<string, string>) {
  const asked: { server: string; ask: boolean }[] = [];
  const page = new EventTarget();
  const said = (state: string) => page.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: state }));
  askAboutLocalNetwork(async (server, ask) => {
    asked.push({ server, ask });
    return answers[server] ?? "public";
  }, page);
  return { asked, said, answers };
}

const HOME = "https://linger.home.example";
const AWAY = "https://linger.example";

afterEach(() => {
  resetLocalNetwork();
  vi.useRealTimers();
});

describe("a server on the phone's own network (#842)", () => {
  it("waits for nothing off the phone app, or once Linger's allowed", async () => {
    // At once, not a promise: a request starts as it always did.
    expect(reachLocal(HOME)).toBe("clear");
    phone({ [HOME]: "allowed" });
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("clear");
    expect(reachLocal(HOME)).toBe("clear");
  });

  it("asks the phone about every server until Linger is allowed, and then nothing", async () => {
    const { asked, answers } = phone({});
    await expect(Promise.resolve(reachLocal(AWAY))).resolves.toBe("clear");
    await expect(Promise.resolve(reachLocal(AWAY))).resolves.toBe("clear");
    // The phone moves to the network the server's on: asked each time, so
    // a name that looks up somewhere else at home is caught there.
    expect(asked).toEqual([{ server: AWAY, ask: true }, { server: AWAY, ask: true }]);
    answers[HOME] = "allowed";
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("clear");
    await expect(Promise.resolve(reachLocal(AWAY))).resolves.toBe("clear");
    expect(asked).toHaveLength(3);
  });

  it("waits for the person's answer, and a yes holds for every server", async () => {
    const { asked, said } = phone({ [HOME]: "asking" });
    const reach = Promise.resolve(reachLocal(HOME));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    let done = false;
    void reach.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    said("granted");
    await expect(reach).resolves.toBe("clear");
    await expect(Promise.resolve(reachLocal(AWAY))).resolves.toBe("clear");
    expect(asked).toHaveLength(1);
  });

  it("hears an answer that comes before the phone's reply", async () => {
    const page = new EventTarget();
    askAboutLocalNetwork(async () => {
      page.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: "granted" }));
      return "asking";
    }, page);
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("clear");
  });

  it("puts up one dialog for requests made while it's up", async () => {
    const { asked, said } = phone({ [HOME]: "asking" });
    const first = Promise.resolve(reachLocal(HOME));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    const second = Promise.resolve(reachLocal(HOME));
    const third = Promise.resolve(reachLocal(AWAY));
    said("granted");
    await expect(Promise.all([first, second, third])).resolves.toEqual(["clear", "clear", "clear"]);
    expect(asked).toEqual([{ server: HOME, ask: true }]);
  });

  it("after a no, never asks again, and still says which servers it holds back", async () => {
    const { asked, said, answers } = phone({ [HOME]: "asking" });
    const reach = Promise.resolve(reachLocal(HOME));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    said("denied");
    await expect(reach).resolves.toBe("blocked");
    answers[HOME] = "denied";
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("blocked");
    await expect(Promise.resolve(reachLocal(AWAY))).resolves.toBe("clear");
    expect(asked.slice(1)).toEqual([{ server: HOME, ask: false }, { server: AWAY, ask: false }]);
    // Allowed in the phone's settings afterwards: the phone says so.
    answers[HOME] = "allowed";
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("clear");
  });

  it("an ask Android dropped, or no answer in a minute, asks again next time", async () => {
    vi.useFakeTimers();
    const { asked, said } = phone({ [HOME]: "asking" });
    const dropped = Promise.resolve(reachLocal(HOME));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    said("unanswered");
    await expect(dropped).resolves.toBe("blocked");
    const unanswered = Promise.resolve(reachLocal(HOME));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(unanswered).resolves.toBe("blocked");
    expect(asked.map((each) => each.ask)).toEqual([true, true]);
  });

  it("a phone that can't say goes ahead", async () => {
    askAboutLocalNetwork(async () => {
      throw new Error("no such command");
    }, new EventTarget());
    await expect(Promise.resolve(reachLocal(HOME))).resolves.toBe("clear");
  });
});
