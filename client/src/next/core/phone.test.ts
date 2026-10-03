import { afterEach, describe, expect, it, vi } from "vitest";
import { followKeyboard, isPhone, type Online, type Showing, thisDevice, type Visible, watchBackground, watchNetwork } from "./phone";
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

/** The visible part of a 914-tall page, which the test can cover with a keyboard. */
function screen(): Visible & { keyboard(height: number, slid: number): void } {
  const listeners = new Set<() => void>();
  const held = {
    height: 914,
    offsetTop: 0,
    addEventListener: (_: "resize" | "scroll", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: "resize" | "scroll", listener: () => void) => void listeners.delete(listener),
    keyboard(height: number, slid: number) {
      held.height = 914 - height;
      held.offsetTop = slid;
      for (const listener of listeners) listener();
    },
  };
  return held;
}

function root() {
  const props = new Map<string, string>();
  return { props, style: { setProperty: (name: string, value: string) => void props.set(name, value) }, dataset: {} as Record<string, string | undefined> };
}

describe("the phone's keyboard (T-1603)", () => {
  it("keeps the page to what the keyboard leaves, where the browser slid it", () => {
    const shown = screen();
    const page = root();
    followKeyboard(shown, () => 914, page);
    expect(page.props.get("--phone-height")).toBe("914px");
    expect(page.dataset.keyboard).toBe("down");
    shown.keyboard(336, 316);
    expect(page.props.get("--phone-height")).toBe("578px");
    expect(page.props.get("--phone-top")).toBe("316px");
    expect(page.dataset.keyboard).toBe("up");
    shown.keyboard(0, 0);
    expect(page.dataset.keyboard).toBe("down");
  });

  it("doesn't take a toolbar coming and going for the keyboard", () => {
    const shown = screen();
    const page = root();
    followKeyboard(shown, () => 914, page);
    shown.keyboard(56, 0);
    expect(page.dataset.keyboard).toBe("down");
  });
});
