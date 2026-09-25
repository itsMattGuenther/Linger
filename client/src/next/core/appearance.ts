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

/** The size this window is zoomed to; 100 when it opened, at its designed size. */
let applied = 100;

/** Apply what's saved to this window. */
export async function applyAppearance(): Promise<void> {
  applyNormalize(loadNormalize());
  const scale = loadScale();
  if (!isTauri() || scale === applied) return;
  const from = applied;
  applied = scale;
  const window = getCurrentWindow();
  try {
    await getCurrentWebview().setZoom(scale / 100);
    const factor = await window.scaleFactor();
    const inner = (await window.innerSize()).toLogical(factor);
    const next = resizedFor(inner, from, scale);
    await window.setSize(new LogicalSize(next.width, next.height));
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
