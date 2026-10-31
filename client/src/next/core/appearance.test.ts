import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The desktop shell: a window that remembers its zoom, size and smallest size, on a 1920 by 1080 screen with a 40 px panel.
const shell = vi.hoisted(() => ({
  zoom: 1,
  size: { width: 340, height: 820 },
  least: null as { width: number; height: number } | null,
  label: "main",
  broadcast: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async () => undefined }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: async (factor: number) => {
      shell.zoom = factor;
    },
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  },
  getCurrentWindow: () => ({
    label: shell.label,
    scaleFactor: async () => 2,
    innerSize: async () => ({ toLogical: () => ({ ...shell.size }) }),
    setSize: async (size: { width: number; height: number }) => {
      shell.size = { width: size.width, height: size.height };
    },
    setMinSize: async (size: { width: number; height: number }) => {
      shell.least = { width: size.width, height: size.height };
    },
  }),
}));
vi.mock("./bus", () => ({
  PROTOCOL: 1,
  tauriBus: () => ({ broadcast: async (event: string, payload: unknown) => void shell.broadcast.push([event, payload]), listen: async () => () => undefined }),
}));

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  shell.zoom = 1;
  shell.size = { width: 340, height: 820 };
  shell.least = null;
  shell.label = "main";
  shell.broadcast = [];
  vi.stubGlobal("window", {
    location: { search: "" },
    screen: { availWidth: 1920, availHeight: 1040 },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) },
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} as Record<string, string> } });
});
afterEach(() => vi.unstubAllGlobals());

describe("how the new client looks, in every window", () => {
  it("grows a window with its interface size, so its layout keeps its width", async () => {
    vi.resetModules();
    const { announceAppearance, applyAppearance, resizedFor, saveScale } = await import("./appearance");
    expect(resizedFor({ width: 340, height: 820 }, 100, 150)).toEqual({ width: 510, height: 1230 });
    expect(resizedFor({ width: 510, height: 1230 }, 150, 125)).toEqual({ width: 425, height: 1025 });

    // Opening at 150%: zoomed, and one and a half times the size it was built at.
    saveScale(150);
    await applyAppearance();
    expect(shell.zoom).toBe(1.5);
    expect(shell.size).toEqual({ width: 510, height: 1230 });
    // Applying again changes nothing.
    await applyAppearance();
    expect(shell.size).toEqual({ width: 510, height: 1230 });

    // Settings changes it: every window hears, and this one follows.
    saveScale(100);
    announceAppearance();
    await vi.waitFor(() => expect(shell.size).toEqual({ width: 340, height: 820 }));
    expect(shell.zoom).toBe(1);
    expect(shell.broadcast).toContainEqual(["next:appearance", { v: 1 }]);
  });

  it("a window remembered at a size opens at it, and doesn't grow again on every run", async () => {
    vi.resetModules();
    let run = await import("./appearance");
    run.saveScale(150);
    await run.applyAppearance();
    expect(shell.size).toEqual({ width: 510, height: 1230 });

    // A new run: the shell has put the window back at the size it was, 510 wide.
    vi.resetModules();
    run = await import("./appearance");
    shell.zoom = 1;
    await run.applyAppearance();
    expect(shell.zoom).toBe(1.5);
    expect(shell.size).toEqual({ width: 510, height: 1230 });

    // Back to 100 in that run: it shrinks to what it was made for.
    run.saveScale(100);
    await run.applyAppearance();
    expect(shell.size).toEqual({ width: 340, height: 820 });
  });

  it("two changes at once grow the window once, to the size last asked for", async () => {
    vi.resetModules();
    const { applyAppearance, saveScale } = await import("./appearance");
    saveScale(150);
    // Settings applies it itself and hears its own announcement: two at once.
    await Promise.all([applyAppearance(), applyAppearance()]);
    expect(shell.size).toEqual({ width: 510, height: 1230 });
    // Two quick changes: it ends at the last one, from where it was.
    saveScale(125);
    const first = applyAppearance();
    saveScale(200);
    await Promise.all([first, applyAppearance()]);
    expect(shell.size).toEqual({ width: 680, height: 1640 });
    expect(shell.zoom).toBe(2);
  });

  it("grows a window's smallest size with the interface size, so the page is never squeezed below its design (#512)", async () => {
    vi.resetModules();
    const { applyAppearance, saveScale, scaledMinimum, WINDOW_MINIMUMS } = await import("./appearance");
    // At 150% the list's 300 was 200 of the page's pixels: the message box over it got 8.
    saveScale(150);
    await applyAppearance();
    expect(shell.least).toEqual({ width: 450, height: 720 });
    saveScale(100);
    await applyAppearance();
    expect(shell.least).toEqual({ width: 300, height: 480 });

    // Each window by its own floor: Settings cut its fields off at 150%.
    shell.label = "settings";
    saveScale(150);
    await applyAppearance();
    expect(shell.least).toEqual({ width: 840, height: 720 });
    shell.label = "chat-00ff00ff00ff00ff";
    await applyAppearance();
    expect(shell.least).toEqual({ width: 540, height: 540 });
    shell.label = "media";
    await applyAppearance();
    expect(shell.least).toEqual({ width: 540, height: 630 });

    // Never more than nine tenths of a small screen.
    expect(scaledMinimum(WINDOW_MINIMUMS.settings, 200, { width: 1366, height: 768 })).toEqual({ width: 1120, height: 691 });
    expect(scaledMinimum(WINDOW_MINIMUMS.list, 200, null)).toEqual({ width: 600, height: 960 });
  });

  it("knows the floors the desktop shell builds each window with", async () => {
    const { WINDOW_MINIMUMS } = await import("./appearance");
    const config = JSON.parse(readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      app: { windows: Array<{ minWidth: number; minHeight: number }> };
    };
    expect({ width: config.app.windows[0]?.minWidth, height: config.app.windows[0]?.minHeight }).toEqual(WINDOW_MINIMUMS.list);
    const rust = readFileSync(new URL("../../../src-tauri/src/window.rs", import.meta.url), "utf8");
    const floors = [...rust.matchAll(/\.title\("([^"]+)"\)[\s\S]*?\.min_inner_size\(([\d.]+), ([\d.]+)\)/g)].map(
      ([, title, width, height]) => [title, { width: Number(width), height: Number(height) }],
    );
    // window.rs titles a conversation's window "Linger", Settings "Linger Settings", and Search and Media by a variable.
    expect(floors).toEqual([
      ["Linger", WINDOW_MINIMUMS.chat],
      ["Linger Settings", WINDOW_MINIMUMS.settings],
    ]);
    expect(rust).toMatch(new RegExp(`\\.title\\(title\\)\\s*\\.inner_size\\(width, height\\)\\s*\\.min_inner_size\\(${WINDOW_MINIMUMS.tool.width}\\.0, ${WINDOW_MINIMUMS.tool.height}\\.0\\)`));
  });

  it("saves only sizes on the list, and 100 for anything else", async () => {
    vi.resetModules();
    const { loadScale, saveScale } = await import("./appearance");
    expect(saveScale(175)).toBe(175);
    expect(loadScale()).toBe(175);
    expect(saveScale(133)).toBe(100);
    expect(loadScale()).toBe(100);
  });

  it("applies plain names from what's saved", async () => {
    vi.resetModules();
    const { applyAppearance } = await import("./appearance");
    const { saveNormalize } = await import("../../lib/normalize");
    saveNormalize(true);
    const root = document.documentElement as unknown as { dataset: Record<string, string> };
    await applyAppearance();
    expect(root.dataset.normalize).toBe("true");
  });

  it("changes nothing when storage refuses a choice, and says so, for Settings to tell (#782)", async () => {
    vi.resetModules();
    const { applyAppearance, loadHideReactions, loadOneLine, loadScale, saveHideReactions, saveOneLine, saveScale } = await import("./appearance");
    const { loadNormalize, saveNormalize } = await import("../../lib/normalize");
    // Chosen while storage worked.
    expect(saveScale(125)).toBe(125);
    expect(saveOneLine(true)).toBe(true);
    expect(saveHideReactions(true)).toBe(true);
    expect(saveNormalize(true)).toBe(true);
    // Full: each new choice is refused, and says it was.
    const local = window.localStorage as { setItem: (key: string, value: string) => void };
    local.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(saveScale(150)).toBeNull();
    expect(saveOneLine(false)).toBe(false);
    expect(saveHideReactions(false)).toBe(false);
    expect(saveNormalize(false)).toBe(false);
    // Every window applies what was chosen before.
    expect([loadScale(), loadOneLine(), loadHideReactions(), loadNormalize()]).toEqual([125, true, true, true]);
    await applyAppearance();
    expect(shell.zoom).toBe(1.25);
    expect((document.documentElement as unknown as { dataset: Record<string, string> }).dataset.normalize).toBe("true");
    // Gone altogether: refused the same way.
    vi.stubGlobal("window", {});
    expect(saveScale(150)).toBeNull();
    expect(saveOneLine(false)).toBe(false);
    expect(saveHideReactions(false)).toBe(false);
    expect(saveNormalize(false)).toBe(false);
  });

  it("keeps the phone's Text size until the app closes when storage refuses it (#780)", async () => {
    vi.resetModules();
    const { loadTextSize, saveTextSize } = await import("./appearance");
    // Full: what was saved before reads back, and a new choice won't write.
    storage.set("linger.next.textSize", "115");
    const local = window.localStorage as { setItem: (key: string, value: string) => void };
    local.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(saveTextSize(150)).toBe(150);
    expect(loadTextSize()).toBe(150);
    // Gone altogether: neither reading nor writing works.
    vi.stubGlobal("window", {});
    expect(saveTextSize(130)).toBe(130);
    expect(loadTextSize()).toBe(130);
  });

  it("saves only the phone's Text size steps, and 100 for anything else (#690)", async () => {
    vi.resetModules();
    const { loadTextSize, saveTextSize } = await import("./appearance");
    expect(loadTextSize()).toBe(100);
    expect(saveTextSize(130)).toBe(130);
    expect(storage.get("linger.next.textSize")).toBe("130");
    expect(saveTextSize(175)).toBe(100);
    expect(loadTextSize()).toBe(100);
  });
});
