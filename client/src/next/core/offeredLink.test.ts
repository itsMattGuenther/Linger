import { describe, expect, it } from "vitest";
import { numbering, OFFERED_LINK, type Offered, offerable, watchOfferedLinks } from "./offeredLink";

/** A bus with one event, fired by hand. */
function fakeBus() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    listen<T>(event: string, handler: (payload: T) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (payload: unknown) => void);
      handlers.set(event, list);
      return Promise.resolve(() => handlers.set(event, (handlers.get(event) ?? []).filter((one) => one !== handler)));
    },
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) handler(undefined);
    },
    listening(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a link an invite page sent (#607)", () => {
  it("only an invite or a setup link goes in the paste box", () => {
    expect(offerable("https://linger.example/invite/abcd2345")).toBe("https://linger.example/invite/abcd2345");
    expect(offerable("https://linger.example/setup?token=0123abcd")).toBe("https://linger.example/setup?token=0123abcd");
    expect(offerable("http://localhost:8420/invite/abcd")).toBe("http://localhost:8420/invite/abcd");
    expect(offerable("https://linger.example/sign-in/abcd2345")).toBe("https://linger.example/sign-in/abcd2345");
    for (const link of [null, undefined, "", "linger.example", "https://linger.example/", "https://linger.example/invite/", "not a link", "javascript:alert(1)"]) {
      expect(offerable(link)).toBeNull();
    }
  });

  it("numbers each link, so the same one opened twice is offered twice", () => {
    const offered: Offered[] = [];
    const next = numbering((one) => offered.push(one));
    next("https://linger.example/invite/abcd");
    next("https://linger.example/invite/abcd");
    expect(offered).toEqual([
      { link: "https://linger.example/invite/abcd", n: 1 },
      { link: "https://linger.example/invite/abcd", n: 2 },
    ]);
  });

  it("takes the link that opened Linger, then each one the shell says is waiting", async () => {
    const bus = fakeBus();
    const waiting = ["https://linger.example/invite/first", "https://other.example/invite/second"];
    let asked = 0;
    const take = () => {
      asked += 1;
      return Promise.resolve(waiting.shift() ?? null);
    };
    const got: string[] = [];
    const stop = watchOfferedLinks(bus, take, (link) => got.push(link));
    await settle();
    expect(got).toEqual(["https://linger.example/invite/first"]);
    bus.fire(OFFERED_LINK);
    await settle();
    expect(got).toEqual(["https://linger.example/invite/first", "https://other.example/invite/second"]);
    // Nothing waiting: nothing offered.
    bus.fire(OFFERED_LINK);
    await settle();
    expect(got).toHaveLength(2);
    expect(asked).toBe(3);
    stop();
    expect(bus.listening(OFFERED_LINK)).toBe(0);
  });

  it("drops anything the shell hands over that isn't an invite or setup link", async () => {
    const bus = fakeBus();
    const got: string[] = [];
    watchOfferedLinks(bus, () => Promise.resolve("https://linger.example/"), (link) => got.push(link));
    await settle();
    expect(got).toEqual([]);
  });

  it("says nothing once the list window has gone", async () => {
    const bus = fakeBus();
    let answer: (link: string | null) => void = () => undefined;
    const got: string[] = [];
    const stop = watchOfferedLinks(
      bus,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      (link) => got.push(link),
    );
    await settle();
    stop();
    answer("https://linger.example/invite/late");
    await settle();
    expect(got).toEqual([]);
  });

  it("a window gone before it was listening never takes the link, so the next one gets it", async () => {
    const bus = fakeBus();
    const waiting = ["https://linger.example/invite/first"];
    const take = () => Promise.resolve(waiting.shift() ?? null);
    const first: string[] = [];
    const second: string[] = [];
    // As React's development mode does: start, stop at once, start again.
    watchOfferedLinks(bus, take, (link) => first.push(link))();
    watchOfferedLinks(bus, take, (link) => second.push(link));
    await settle();
    expect(first).toEqual([]);
    expect(second).toEqual(["https://linger.example/invite/first"]);
  });

  it("a shell that can't answer is not an error", async () => {
    const bus = fakeBus();
    const got: string[] = [];
    watchOfferedLinks(bus, () => Promise.reject(new Error("no shell")), (link) => got.push(link));
    await settle();
    expect(got).toEqual([]);
  });
});
