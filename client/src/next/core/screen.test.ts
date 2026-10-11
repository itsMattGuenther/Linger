import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageScreen, screenAround } from "./screen";
import { unfolding } from "./side";

describe("the screen, as the page sees it", () => {
  it("reads the work area and the window's own box from the engine", () => {
    const view = { screen: { availWidth: 1920, availHeight: 1040, availLeft: 1920 }, screenX: 2400, outerWidth: 340 };
    expect(pageScreen(view)).toEqual({ left: 1920, width: 1920, height: 1040, windowLeft: 2400, windowWidth: 340 });
  });

  it("starts at 0 where the engine has no left edge, or the window no place (Wayland)", () => {
    expect(pageScreen({ screen: { availWidth: 1920, availHeight: 1040 } })).toEqual({ left: 0, width: 1920, height: 1040, windowLeft: 0, windowWidth: 0 });
  });

  it("is nothing where the engine gives no screen", () => {
    expect(pageScreen(undefined)).toBeNull();
    expect(pageScreen({})).toBeNull();
    expect(pageScreen({ screen: { availWidth: 0, availHeight: 1040 } })).toBeNull();
    expect(pageScreen({ screen: { availWidth: Number.NaN, availHeight: 1040 } })).toBeNull();
  });
});

describe("the screen, placed around the window in the shell's pixels", () => {
  const side = { unfolded: false, list: 340, pane: 780 };

  it("is the screen itself when the page and the shell count from the same place", () => {
    const seen = { left: 0, width: 1920, height: 1040, windowLeft: 1500, windowWidth: 340 };
    expect(screenAround({ x: 1500, width: 340 }, seen)).toEqual({ x: 0, width: 1920 });
    // So a window near the right edge still grows leftwards, as with the shell's monitor.
    expect(unfolding({ x: 1500, width: 340 }, screenAround({ x: 1500, width: 340 }, seen), side, 1)).toEqual({ width: 1120, x: 800 });
  });

  it("finds a second screen to the right", () => {
    const seen = { left: 1920, width: 1920, height: 1040, windowLeft: 3500, windowWidth: 340 };
    expect(screenAround({ x: 3500, width: 340 }, seen)).toEqual({ x: 1920, width: 1920 });
  });

  it("carries only distances over, so two screens at different scales still line up", () => {
    // A 4K screen at 200% right of a 1080p one at 100%: Windows' engine puts
    // it at 1920 of its own pixels, the shell (physical over scale) at 960.
    // The window sits 1580 px into that screen either way.
    const seen = { left: 1920, width: 1920, height: 1080, windowLeft: 3500, windowWidth: 340 };
    const screen = screenAround({ x: 2540, width: 340 }, seen);
    expect(screen).toEqual({ x: 960, width: 1920 });
    expect(unfolding({ x: 2540, width: 340 }, screen, side, 1)).toEqual({ width: 1120, x: 1760 });
  });

  it("scales by the window's outer width if an engine ever counts the screen zoomed", () => {
    // At 200%, such an engine would say the 1920 px screen is 960 wide and the window 170.
    const seen = { left: 0, width: 960, height: 520, windowLeft: 750, windowWidth: 170 };
    expect(screenAround({ x: 1500, width: 340 }, seen)).toEqual({ x: 0, width: 1920 });
  });

  it("uses no ratio when the window's own numbers make no sense", () => {
    const seen = { left: 0, width: 1920, height: 1040, windowLeft: 1500, windowWidth: 0 };
    expect(screenAround({ x: 1500, width: 340 }, seen)).toEqual({ x: 0, width: 1920 });
    expect(screenAround({ x: 1500, width: 340 }, { ...seen, windowWidth: 1 })).toEqual({ x: 0, width: 1920 });
  });
});

// --- never the shell's monitor (#623, #628) ---------------------------------

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Code that ships: TypeScript under src/next and src/lib, tests and comments left out. */
const SHIPPED = [...walk(join(SRC, "next")), ...walk(join(SRC, "lib"))].filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file));

describe("the app never asks the shell for a monitor", () => {
  it("reads enough to mean something", () => {
    expect(SHIPPED.length).toBeGreaterThan(100);
  });

  it("leaves currentMonitor and its kin to the page's own screen (core/screen.ts)", () => {
    // On Linux, Tauri reads the GTK monitor off its thread: the packaged app
    // exited about half the time when one was asked for (#623, #628).
    const found = SHIPPED.flatMap((file) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
        .split("\n")
        .flatMap((line, index) => (/\b(currentMonitor|primaryMonitor|availableMonitors|monitorFromPoint)\b|plugin:window\|(current_monitor|primary_monitor|available_monitors|monitor_from_point)/.test(line) ? [`${relative(SRC, file)}:${index + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
