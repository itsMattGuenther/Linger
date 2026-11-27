import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, DEFAULT_THEME, followThemeInShell, loadTheme, saveTheme, THEME_KEY, THEMES } from "./theme";

const BOOT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../public/theme.js"), "utf8");

/** This computer's storage, which can be made to refuse a save or to answer nothing at all. */
const storage = new Map<string, string>();
let refuseSaves = false;
let noStorage = false;
const root = { dataset: {} as Record<string, string>, attributes: new Map<string, string>() };

beforeEach(() => {
  storage.clear();
  refuseSaves = false;
  noStorage = false;
  root.dataset = {};
  root.attributes.clear();
  vi.stubGlobal("window", {
    get localStorage() {
      if (noStorage) throw new DOMException("The operation is insecure.", "SecurityError");
      return {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (refuseSaves) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          storage.set(key, value);
        },
      };
    },
  });
  vi.stubGlobal("document", { documentElement: root });
});

afterEach(() => vi.unstubAllGlobals());

describe("the theme chosen on this computer or phone (#964)", () => {
  it("is The door until one is chosen, and whatever was chosen after", () => {
    expect(DEFAULT_THEME).toBe("door");
    expect(loadTheme()).toBe("door");
    for (const { id } of THEMES) {
      expect(saveTheme(id)).toBe(true);
      expect(storage.get(THEME_KEY)).toBe(id);
      expect(loadTheme()).toBe(id);
    }
  });

  it("reads anything it doesn't know as The door: a theme that's gone, or the previous client's dark, light and system", () => {
    for (const stray of ["light", "dark", "system", "", "DUSK", "dusk ", "Daylight", "day-light"]) {
      storage.set(THEME_KEY, stray);
      expect(loadTheme()).toBe("door");
    }
  });

  it("changes nothing when storage refuses a choice, and says so, for Settings to tell (#782)", () => {
    expect(saveTheme("dusk")).toBe(true);
    // Full: the new choice is refused, and what was chosen before still holds.
    refuseSaves = true;
    expect(saveTheme("original")).toBe(false);
    expect(loadTheme()).toBe("dusk");
    // Switched off altogether: refused the same way, and read as The door.
    noStorage = true;
    expect(saveTheme("original")).toBe(false);
    expect(loadTheme()).toBe("door");
  });

  it("goes on the page as data-theme, which every color token follows", () => {
    applyTheme("porch-light");
    expect(root.dataset.theme).toBe("porch-light");
    applyTheme("door");
    expect(root.dataset.theme).toBe("door");
  });
});

// `next.html` runs `public/theme.js` before anything draws, a plain script
// that repeats the key and the themes.
describe("the theme put on before the page draws (public/theme.js)", () => {
  const boot = () => {
    const document = {
      documentElement: { setAttribute: (name: string, value: string) => root.attributes.set(name, value) },
    };
    new Function("window", "document", BOOT)(window, document);
    return root.attributes.get("data-theme");
  };

  it("knows the same themes and reads the same key as the app", () => {
    const listed = /var THEMES = \[([^\]]*)\]/.exec(BOOT)?.[1] ?? "";
    expect(listed.split(",").map((id) => id.trim().replace(/^"|"$/g, ""))).toEqual(THEMES.map((theme) => theme.id));
    expect(BOOT).toContain(`getItem("${THEME_KEY}")`);
  });

  it("puts on the theme saved here, and The door for nothing saved, anything it doesn't know, or storage switched off", () => {
    expect(boot()).toBe("door");
    for (const { id } of THEMES) {
      storage.set(THEME_KEY, id);
      expect(boot()).toBe(id);
    }
    storage.set(THEME_KEY, "light");
    expect(boot()).toBe("door");
    storage.set(THEME_KEY, "dusk");
    noStorage = true;
    expect(boot()).toBe("door");
  });
});

// The shell draws in the theme too (#965): a computer's windows before their
// pages draw, a phone's bars. The list window tells it what's on its page.
describe("the shell told the theme (followThemeInShell)", () => {
  /** The page hearing it applied the look, as `onAppearance` would, and the shell's calls. */
  function shell(refuse = () => false, answer: () => Promise<unknown> = () => Promise.resolve(null)) {
    let applied: (() => void) | null = null;
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const stop = followThemeInShell(
      (listener) => {
        applied = listener;
        return () => {
          applied = null;
        };
      },
      (command, args) => {
        calls.push([command, args]);
        return refuse() ? Promise.reject(new Error("not taken")) : answer();
      },
    );
    const apply = (theme: string) => {
      root.dataset.theme = theme;
      applied?.();
    };
    return { calls, apply, stop, listening: () => applied !== null };
  }

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it("tells the theme on the page at once, then each different one the page applies, once", async () => {
    root.dataset.theme = "dusk";
    const { calls, apply } = shell();
    await settle();
    expect(calls).toEqual([["app_theme", { theme: "dusk" }]]);
    apply("dusk");
    apply("daylight");
    apply("daylight");
    apply("door");
    await settle();
    expect(calls).toEqual([
      ["app_theme", { theme: "dusk" }],
      ["app_theme", { theme: "daylight" }],
      ["app_theme", { theme: "door" }],
    ]);
  });

  it("tells The door for a page with no theme it knows", async () => {
    root.dataset.theme = "light";
    const { calls } = shell();
    await settle();
    expect(calls).toEqual([["app_theme", { theme: "door" }]]);
  });

  it("tells one theme at a time, each once the shell has answered the one before", async () => {
    const answers: Array<() => void> = [];
    root.dataset.theme = "door";
    const { calls, apply } = shell(
      () => false,
      () => new Promise((done) => answers.push(() => done(null))),
    );
    await settle();
    apply("daylight");
    apply("dusk");
    await settle();
    expect(calls.map(([, args]) => args?.theme)).toEqual(["door"]);
    answers.shift()?.();
    await settle();
    expect(calls.map(([, args]) => args?.theme)).toEqual(["door", "daylight"]);
    answers.shift()?.();
    await settle();
    expect(calls.map(([, args]) => args?.theme)).toEqual(["door", "daylight", "dusk"]);
  });

  it("tells it again at the next look when the shell didn't take it", async () => {
    let refusing = true;
    root.dataset.theme = "daylight";
    const { calls, apply } = shell(() => refusing);
    await settle();
    refusing = false;
    apply("daylight");
    await settle();
    expect(calls).toEqual([
      ["app_theme", { theme: "daylight" }],
      ["app_theme", { theme: "daylight" }],
    ]);
    apply("daylight");
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("stops hearing when asked", () => {
    const { listening, stop } = shell();
    expect(listening()).toBe(true);
    stop();
    expect(listening()).toBe(false);
  });
});
