/**
 * How the new client looks on this computer, the same in every window: plain
 * names (NAME-4), interface size (LOOK-1) and one line per person in the
 * list (#197). Settings saves a change and
 * announces it; every window applies it at once, and each applies what's
 * saved when it opens.
 *
 * Interface size zooms the whole page, like a browser's zoom, because the new
 * client's sizes are fixed pixels (docs/design/system.md) and a larger base
 * font would grow nothing. A window grows by the same ratio, so its layout
 * keeps the width it was designed at: a list at 150% is 510 wide, not 340
 * wide with a 227-pixel layout squeezed into it.
 *
 * The desktop shell remembers each window's size between runs
 * (`remembered_windows` in src-tauri/src/window.rs), so each window also
 * remembers which interface size it was last sized for and only grows or
 * shrinks by the difference: a window remembered at 150% opens at 150% and
 * doesn't grow again.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { validScale } from "../../lib/interface";
import { applyNormalize, loadNormalize } from "../../lib/normalize";
import { PROTOCOL, tauriBus } from "./bus";
import { onPhone } from "./phone";

/** Settings changed how things look; every window applies it. */
export const APPEARANCE = "next:appearance";

/** The same key the previous client used, so an update keeps the size. */
const SCALE_KEY = "linger.interface.scale";

export function loadScale(): number {
  try {
    return validScale(Number(window.localStorage.getItem(SCALE_KEY)));
  } catch {
    return 100;
  }
}

/** Save an interface size; anything not on the list is 100. Returns what was saved. */
export function saveScale(value: number): number {
  const scale = validScale(value);
  try {
    window.localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    // Storage refused: this session still gets what was asked for.
  }
  return scale;
}

/** One line per person in the list (#197): off unless turned on. */
const ONE_LINE_KEY = "linger.next.peopleOneLine";

export function loadOneLine(): boolean {
  try {
    return window.localStorage.getItem(ONE_LINE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Save one line per person; announce it with `announceAppearance`. */
export function saveOneLine(on: boolean): void {
  try {
    window.localStorage.setItem(ONE_LINE_KEY, String(on));
  } catch {
    // Storage refused: this window still gets it, until it's opened again.
  }
}

/** Reactions hidden on this computer (#485): shown unless turned off. */
const HIDE_REACTIONS_KEY = "linger.next.hideReactions";

export function loadHideReactions(): boolean {
  try {
    return window.localStorage.getItem(HIDE_REACTIONS_KEY) === "true";
  } catch {
    return false;
  }
}

/** Save hiding reactions; announce it with `announceAppearance`. */
export function saveHideReactions(hidden: boolean): void {
  try {
    window.localStorage.setItem(HIDE_REACTIONS_KEY, String(hidden));
  } catch {
    // Storage refused: this window still gets it, until it's opened again.
  }
}

/** Plain names: applied to this window, and saved for the others. */
export function saveNormalize(on: boolean): void {
  applyNormalize(on);
}

/** A window's size after a change of interface size: grown or shrunk by the same ratio. */
export function resizedFor(size: { width: number; height: number }, from: number, to: number): { width: number; height: number } {
  const ratio = to / from;
  return { width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) };
}

/**
 * The smallest each window may be at 100%, as the desktop shell builds it:
 * the list in `src-tauri/tauri.conf.json`, the others in
 * `src-tauri/src/window.rs`. `appearance.test.ts` reads both, so the numbers
 * here can't drift from them.
 */
export const WINDOW_MINIMUMS = {
  list: { width: 300, height: 480 },
  chat: { width: 360, height: 360 },
  settings: { width: 560, height: 480 },
  tool: { width: 360, height: 420 },
} as const;

/** Which of `WINDOW_MINIMUMS` a window is, by the label the shell gave it. */
export function windowKind(label: string): keyof typeof WINDOW_MINIMUMS {
  if (label === "settings") return "settings";
  if (label === "search" || label === "media") return "tool";
  if (label.startsWith("chat-")) return "chat";
  return "list";
}

/**
 * A window's smallest size at an interface size (#512): the one it was
 * designed at, grown by the same ratio as the page, so the page is never
 * squeezed below the width its layout was made for. At 150% the list's 300
 * would otherwise be 200 of the page's pixels, and the message box over it
 * an 8 px slot. Never more than nine tenths of the screen, so a big size on
 * a small screen still leaves a window that fits on it.
 */
export function scaledMinimum(
  designed: { width: number; height: number },
  scale: number,
  screen: { width: number; height: number } | null,
): { width: number; height: number } {
  const grown = resizedFor(designed, 100, scale);
  if (!screen) return grown;
  return {
    width: Math.min(grown.width, Math.floor(screen.width * 0.9)),
    height: Math.min(grown.height, Math.floor(screen.height * 0.9)),
  };
}

/** The zoom this page has; a page opens at 100. */
let zoomed = 100;

/** Which interface size a window's size was last made for, kept per window. */
function sizedForKey(label: string): string {
  return `linger.next.windowScale.${label}`;
}

/**
 * Apply what's saved to this window, one run at a time. Two at once (Settings
 * applies a change and also hears its own announcement) would each read the
 * window's size before the other had grown it, and grow it twice. A call made
 * during a run waits for it, and one more run then applies what's saved by
 * then.
 */
let running: Promise<void> | null = null;
let again = false;
/** What a window draws from these choices itself, told when they're applied. */
const listeners = new Set<() => void>();

/**
 * Hear every time this window applies what's saved: a choice a screen draws
 * from rather than the page's CSS, like one line per person (#197). Returns
 * how to stop.
 */
export function onAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyAppearance(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  const run = (async () => {
    do {
      again = false;
      await applyOnce();
    } while (again);
  })();
  running = run.finally(() => {
    running = null;
  });
  return running;
}

async function applyOnce(): Promise<void> {
  applyNormalize(loadNormalize());
  for (const listener of listeners) listener();
  const scale = loadScale();
  if (!isTauri()) return;
  const current = getCurrentWindow();
  try {
    if (zoomed !== scale) {
      zoomed = scale;
      await getCurrentWebview().setZoom(scale / 100);
    }
    // Before any resize: a smaller window may need the old floor gone first.
    await keepMinimum(current.label, scale);
    let sizedFor = 100;
    try {
      sizedFor = validScale(Number(window.localStorage.getItem(sizedForKey(current.label)) ?? "100"));
    } catch {
      // Storage refused: treat the window as its designed size.
    }
    if (sizedFor === scale) return;
    const factor = await current.scaleFactor();
    const inner = (await current.innerSize()).toLogical(factor);
    const next = resizedFor(inner, sizedFor, scale);
    await current.setSize(new LogicalSize(next.width, next.height));
    try {
      window.localStorage.setItem(sizedForKey(current.label), String(scale));
    } catch {
      // Storage refused: the next run sizes it from its designed size again.
    }
  } catch {
    // A desktop that won't resize (a tiling one) still gets the zoom.
  }
}

/**
 * The window's smallest size, grown with the interface size (#512). A phone's
 * screen is the window, so it has none. A desktop that ignores it (a tiling
 * one) still gets the zoom and the resize.
 *
 * The screen's size is the page's own (`window.screen`), never the shell's
 * `currentMonitor()`: on Linux, Tauri reads the monitor's details off GTK's
 * thread, and asked for as the window opens, that crashed the packaged app
 * about half the time (#623). An engine that shrinks the screen by the page's
 * zoom only makes the floor smaller, the safe way to be wrong.
 */
async function keepMinimum(label: string, scale: number): Promise<void> {
  if (onPhone()) return;
  try {
    const shown = window.screen as Screen | undefined;
    const screen = shown && shown.availWidth > 0 && shown.availHeight > 0 ? { width: shown.availWidth, height: shown.availHeight } : null;
    const least = scaledMinimum(WINDOW_MINIMUMS[windowKind(label)], scale, screen);
    await getCurrentWindow().setMinSize(new LogicalSize(least.width, least.height));
  } catch {
    // Refused or not offered: the window keeps the shell's floor.
  }
}

/** Tell every window, this one included, to apply what's now saved. */
export function announceAppearance(): void {
  void applyAppearance();
  if (isTauri()) void tauriBus().broadcast(APPEARANCE, { v: PROTOCOL });
}

/** Apply what's saved now, and again whenever Settings announces a change. */
export function followAppearance(): void {
  void applyAppearance();
  if (!isTauri()) return;
  void tauriBus().listen<{ v: number }>(APPEARANCE, (message) => {
    if (message.v === PROTOCOL) void applyAppearance();
  });
}
