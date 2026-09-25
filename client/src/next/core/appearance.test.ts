import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The desktop shell: a window that remembers its zoom and size.
const shell = vi.hoisted(() => ({ zoom: 1, size: { width: 340, height: 820 }, broadcast: [] as unknown[] }));
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
    scaleFactor: async () => 2,
    innerSize: async () => ({ toLogical: () => ({ ...shell.size }) }),
    setSize: async (size: { width: number; height: number }) => {
      shell.size = { width: size.width, height: size.height };
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
  vi.stubGlobal("window", {
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
    const { applyAppearance, saveNormalize } = await import("./appearance");
    saveNormalize(true);
    const root = document.documentElement as unknown as { dataset: Record<string, string> };
    delete root.dataset.normalize;
    await applyAppearance();
    expect(root.dataset.normalize).toBe("true");
  });
});
