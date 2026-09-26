/**
 * How the new client looks on this computer, the same in every window: plain
 * names (NAME-4) and interface size (LOOK-1). Settings saves a change and
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

/** Settings changed how things look; every window applies it. */
export const APPEARANCE = "next:appearance";

/** The same key as today's client, so switching clients keeps the size. */
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

/** Plain names: applied to this window, and saved for the others. */
export function saveNormalize(on: boolean): void {
  applyNormalize(on);
}

/** A window's size after a change of interface size: grown or shrunk by the same ratio. */
export function resizedFor(size: { width: number; height: number }, from: number, to: number): { width: number; height: number } {
  const ratio = to / from;
  return { width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) };
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
  const scale = loadScale();
  if (!isTauri()) return;
  const current = getCurrentWindow();
  try {
    if (zoomed !== scale) {
      zoomed = scale;
      await getCurrentWebview().setZoom(scale / 100);
    }
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
