import { afterEach, describe, expect, it, vi } from "vitest";
import { chosenTextScale, closeKeyboardOnTouch, DRAG_PX, type Fingers, followKeyboard, followTextSize, isIPhone, isLinuxApp, isPhone, type Online, type Showing, type TextPage, textScale, thisDevice, type Touchable, typingIn, type Visible, watchBackground, watchNetwork } from "./phone";
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

  it("knows an iPhone's engine from Android's, so only an iPhone swipes back in the page (#697)", () => {
    // An iPhone's web view, and an iPad asking for a computer's page.
    expect(isIPhone("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5)).toBe(true);
    expect(isIPhone("Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5)).toBe(true);
    expect(isIPhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", 5)).toBe(true);
    // Android's web view has a Back of its own; a Mac has no touch screen.
    expect(isIPhone("Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36", 5)).toBe(false);
    expect(isIPhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", 0)).toBe(false);
    expect(isIPhone("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", 10)).toBe(false);
  });

  it("knows the Linux app from Android, Windows and a browser, though Android's engine names Linux too (#702)", () => {
    const webkitgtk = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
    expect(isLinuxApp(webkitgtk, true)).toBe(true);
    // The same engine in a browser, with `pnpm dev`: no shell, so not the app.
    expect(isLinuxApp(webkitgtk, false)).toBe(false);
    expect(isLinuxApp("Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36", true)).toBe(false);
    expect(isLinuxApp("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", true)).toBe(false);
    expect(isLinuxApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", true)).toBe(false);
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

  it("says when the app comes back within the grace, so connections Android cut off try again at once", () => {
    vi.useFakeTimers();
    const shown = page();
    const heard: string[] = [];
    watchBackground(
      shown,
      60_000,
      (away) => heard.push(away ? "away" : "here"),
      () => heard.push("back"),
    );
    shown.show("visible");
    expect(heard).toEqual([]);
    shown.show("hidden");
    vi.advanceTimersByTime(20_000);
    shown.show("visible");
    expect(heard).toEqual(["back"]);
    // Past the grace the connections were closed, and opening them is a fresh start.
    shown.show("hidden");
    vi.advanceTimersByTime(60_000);
    shown.show("visible");
    expect(heard).toEqual(["back", "away", "here"]);
  });

  it("says the moment the app leaves the screen, once a trip, so what's waiting goes before Android blocks the network (#454)", () => {
    vi.useFakeTimers();
    const shown = page();
    let left = 0;
    watchBackground(
      shown,
      60_000,
      () => undefined,
      undefined,
      () => (left += 1),
    );
    expect(left).toBe(0);
    shown.show("hidden");
    expect(left).toBe(1);
    shown.show("hidden");
    vi.advanceTimersByTime(60_000);
    expect(left).toBe(1);
    shown.show("visible");
    shown.show("hidden");
    expect(left).toBe(2);
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

/** The page, which the test puts fingers on, and a field with the keyboard or none. */
function touched(typing: boolean) {
  const now = { typing };
  const listeners = new Map<string, (event: Fingers) => void>();
  const area: Touchable = {
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => void listeners.delete(type),
  };
  const field = { blurs: 0, blur: () => void (field.blurs += 1) };
  const at = (points: [number, number][], target: Fingers["target"] = row): Fingers => ({ target, touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  const fire = (type: string, event: Fingers = at([])) => listeners.get(type)?.(event);
  const stop = closeKeyboardOnTouch(area, () => (now.typing ? field : null));
  return { field, at, fire, stop, listening: () => listeners.size, focus: () => void (now.typing = true) };
}

/** A message, the box a message is edited in, and a button, as `closest` places them. */
const row = { closest: () => null };
const editBox = { closest: (selectors: string) => (selectors.includes("textarea") ? {} : null) };
const send = { closest: (selectors: string) => (selectors.includes("button") ? {} : null) };

describe("putting the iPhone's keyboard away without its bar (#881)", () => {
  it("does it once a finger dragging the page has moved far enough", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[100, 400]]));
    fire("touchmove", at([[100, 400 - DRAG_PX + 1]]));
    expect(field.blurs).toBe(0);
    fire("touchmove", at([[100 + DRAG_PX, 400]]));
    expect(field.blurs).toBe(1);
    fire("touchmove", at([[100, 300]]));
    fire("touchend");
    expect(field.blurs).toBe(1);
  });

  it("does it when a finger tapping the page lifts", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[100, 400]]));
    fire("touchmove", at([[102, 401]]));
    expect(field.blurs).toBe(0);
    fire("touchend");
    expect(field.blurs).toBe(1);
  });

  it("leaves a tap on a control to the control: Send keeps it for the next message", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[370, 480]], send));
    fire("touchend");
    fire("click", at([], send));
    expect(field.blurs).toBe(0);
  });

  it("does it for a drag that starts on a control, through what Search found, say (Greptile on #883)", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[200, 400]], send));
    fire("touchmove", at([[200, 400 - DRAG_PX]], send));
    expect(field.blurs).toBe(1);
  });

  it("leaves it for a finger that starts in a field, where the typing goes", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[100, 400]], editBox));
    fire("touchmove", at([[100, 300]], editBox));
    fire("touchend");
    expect(field.blurs).toBe(0);
  });

  it("leaves it for two fingers, and for a touch iOS took over", () => {
    const { field, at, fire } = touched(true);
    fire("touchstart", at([[100, 400], [200, 400]]));
    fire("touchend");
    fire("touchstart", at([[100, 400]]));
    fire("touchmove", at([[100, 400], [200, 400]]));
    fire("touchmove", at([[100, 300]]));
    fire("touchend");
    fire("touchstart", at([[100, 400]]));
    fire("touchcancel");
    fire("touchend");
    expect(field.blurs).toBe(0);
  });

  it("puts away only a keyboard that was up as the finger came down", () => {
    const { field, at, fire, focus } = touched(false);
    fire("touchstart", at([[100, 400]]));
    fire("touchend");
    // Reply, say, puts the box in focus during the tap: its keyboard stays.
    fire("touchstart", at([[100, 400]]));
    focus();
    fire("touchend");
    expect(field.blurs).toBe(0);
  });

  it("does it for a click, as VoiceOver's double tap is, but in a field or on a control", () => {
    const { field, at, fire } = touched(true);
    fire("click", at([], editBox));
    fire("click", at([], send));
    expect(field.blurs).toBe(0);
    fire("click", at([], row));
    expect(field.blurs).toBe(1);
  });

  it("stops listening when asked", () => {
    const { listening, stop } = touched(true);
    expect(listening()).toBe(5);
    stop();
    expect(listening()).toBe(0);
  });

  it("knows which field has the keyboard: one that takes typing", () => {
    const box = { ...editBox, blur: () => undefined };
    const message = { ...row, blur: () => undefined };
    expect(typingIn({ activeElement: box })).toBe(box);
    expect(typingIn({ activeElement: message })).toBeNull();
    expect(typingIn({ activeElement: editBox })).toBeNull();
    expect(typingIn({ activeElement: null })).toBeNull();
  });
});

describe("the phone's text size (its Font size setting)", () => {
  it("is the phone's factor, to a hundredth, up to twice the usual", () => {
    expect(textScale(1)).toBe(1);
    expect(textScale(1.3)).toBe(1.3);
    expect(textScale(2)).toBe(2);
    expect(textScale(1.149_99)).toBe(1.15);
    expect(textScale(3.5)).toBe(2);
  });

  it("never shrinks Linger, and takes an answer that isn't a number as the usual size", () => {
    expect(textScale(0.85)).toBe(1);
    expect(textScale(Number.NaN)).toBe(1);
    expect(textScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("Linger's own Text size, on top of the phone's (#690)", () => {
  /** A page that keeps what was set on it, and the listeners it was given. */
  function textPage() {
    const set = new Map<string, string>();
    const shown = new Set<() => void>();
    const page: TextPage = {
      visibilityState: "visible",
      documentElement: { style: { setProperty: (name, value) => void set.set(name, value) } },
      addEventListener: (_type, listener) => void shown.add(listener),
      removeEventListener: (_type, listener) => void shown.delete(listener),
    };
    return { page, shown, scale: () => set.get("--text-scale") };
  }

  /** Settings' announcements, as `onAppearance` gives them. */
  function announcer() {
    const listeners = new Set<() => void>();
    return {
      listeners,
      changed: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      announce: () => {
        for (const listener of listeners) listener();
      },
    };
  }

  const answered = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("grows the phone's text size by the step chosen, never past twice the usual", () => {
    expect(chosenTextScale(1, 100)).toBe(1);
    expect(chosenTextScale(1, 150)).toBe(1.5);
    expect(chosenTextScale(1.3, 130)).toBe(1.69);
    expect(chosenTextScale(1.8, 150)).toBe(2);
    // A phone set smaller than the usual, or one that couldn't say, is the usual.
    expect(chosenTextScale(0.85, 115)).toBe(1.15);
    expect(chosenTextScale(Number.NaN, 130)).toBe(1.3);
  });

  it("applies Linger's own size at once, then the phone's under it once it answers", async () => {
    const { page, scale } = textPage();
    followTextSize(page, () => Promise.resolve(1.2), () => 130, announcer().changed);
    expect(scale()).toBe("1.3");
    await answered();
    expect(scale()).toBe("1.56");
  });

  it("follows a new choice in Settings at once, without asking the phone again", async () => {
    const { page, scale } = textPage();
    const settings = announcer();
    let chosen = 100;
    const ask = vi.fn(() => Promise.resolve(1.2));
    followTextSize(page, ask, () => chosen, settings.changed);
    await answered();
    expect(scale()).toBe("1.2");
    chosen = 150;
    settings.announce();
    expect(scale()).toBe("1.8");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks the phone again when the app comes back, and hears nothing once stopped", async () => {
    const { page, shown, scale } = textPage();
    const settings = announcer();
    let phone = 1;
    const stop = followTextSize(page, () => Promise.resolve(phone), () => 115, settings.changed);
    await answered();
    expect(scale()).toBe("1.15");
    // Text Size turned up in the phone's Settings, away from Linger.
    phone = 1.4;
    for (const listener of shown) listener();
    await answered();
    expect(scale()).toBe("1.61");
    stop();
    expect(shown.size).toBe(0);
    expect(settings.listeners.size).toBe(0);
  });
});
