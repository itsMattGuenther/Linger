import { afterEach, describe, expect, it, vi } from "vitest";
import { isPhone, type Online, type Showing, thisDevice, watchBackground, watchNetwork } from "./phone";
import { windowRole } from "./role";

describe("the phone app", () => {
  it("is the page the phone's window opens, and nothing else", () => {
    expect(isPhone("?shell=phone")).toBe(true);
    expect(isPhone("")).toBe(false);
    expect(isPhone("?shell=desktop")).toBe(false);
    expect(isPhone("?window=chat&server=x&room=y")).toBe(false);
  });

  it("is still the list, the owner: its address names no other window", () => {
    expect(windowRole("?shell=phone", "main")).toBe("list");
    expect(windowRole("?shell=phone", null)).toBe("list");
  });

  it("calls the device what it is", () => {
    expect(thisDevice(true)).toBe("this phone");
    expect(thisDevice(false)).toBe("this computer");
  });
});

/** A page whose visibility the test flips. */
function page(): Showing & { show(state: DocumentVisibilityState): void } {
  const listeners = new Set<() => void>();
  const held = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: "visibilitychange", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: "visibilitychange", listener: () => void) => void listeners.delete(listener),
    show(state: DocumentVisibilityState) {
      held.visibilityState = state;
      for (const listener of listeners) listener();
    },
  };
  return held;
}

describe("the phone app in the background (SPEC §4.15)", () => {
  afterEach(() => vi.useRealTimers());

  it("goes away once it has been in the background for the grace, and comes back when it's shown", () => {
    vi.useFakeTimers();
    const shown = page();
    const heard: boolean[] = [];
    watchBackground(shown, 60_000, (away) => heard.push(away));
    shown.show("hidden");
    vi.advanceTimersByTime(59_999);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([true]);
    shown.show("visible");
    expect(heard).toEqual([true, false]);
  });

  it("says nothing for a quick trip elsewhere: picking a photo, copying a link", () => {
    vi.useFakeTimers();
    const shown = page();
    const heard: boolean[] = [];
    watchBackground(shown, 60_000, (away) => heard.push(away));
    shown.show("hidden");
    vi.advanceTimersByTime(30_000);
    shown.show("visible");
    vi.advanceTimersByTime(60_000);
    expect(heard).toEqual([]);
  });

  it("stops listening when asked", () => {
    vi.useFakeTimers();
    const shown = page();
    const heard: boolean[] = [];
    const stop = watchBackground(shown, 60_000, (away) => heard.push(away));
    shown.show("hidden");
    stop();
    vi.advanceTimersByTime(120_000);
    expect(heard).toEqual([]);
  });
});

/** A window whose network the test drops and brings back. */
function network(onLine: boolean): Online & { go(event: "online" | "offline"): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    navigator: { onLine },
    addEventListener: (type, listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(listener),
    removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    go(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe("the phone app's network (T-1602)", () => {
  it("says when the network goes and when it's back", () => {
    const net = network(true);
    const heard: boolean[] = [];
    const stop = watchNetwork(net, (offline) => heard.push(offline));
    expect(heard).toEqual([]);
    net.go("offline");
    net.go("online");
    expect(heard).toEqual([true, false]);
    stop();
    net.go("offline");
    expect(heard).toEqual([true, false]);
  });

  it("starts offline when there's no network at all", () => {
    const heard: boolean[] = [];
    watchNetwork(network(false), (offline) => heard.push(offline));
    expect(heard).toEqual([true]);
  });
});
