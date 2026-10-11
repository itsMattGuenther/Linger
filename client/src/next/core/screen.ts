/**
 * The screen a desktop window is on, as its own page sees it (#623, #628).
 *
 * Never the shell's `currentMonitor()` (or `primaryMonitor()`,
 * `availableMonitors()`, `monitorFromPoint()`): on Linux, tauri-runtime-wry
 * fetches the GTK monitor on the main thread but reads its name, place and
 * size on the command's own thread, and GDK isn't safe to use from two
 * threads at once. Asked for as the list window opened, that made the
 * packaged app exit about half the time (#623). The page's `window.screen`
 * comes from the engine, which asks the desktop on its own main thread.
 * `screen.test.ts` keeps the monitor calls out of the app.
 */
import type { Span } from "./side";

/** The work area and the window's own outer box, in the page's screen pixels. */
export interface PageScreen {
  left: number;
  width: number;
  height: number;
  /** The window's left edge and outer width, measured the same way as the work area. */
  windowLeft: number;
  windowWidth: number;
}

/** What the page offers about its screen: `window`, or a stand-in in tests. */
export interface ScreenView {
  screen?: { availWidth?: number; availHeight?: number } | undefined;
  screenX?: number;
  outerWidth?: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The page's own view of its screen, or null where the engine gives none.
 * `availLeft` isn't in every engine's types, but Chromium (WebView2) and
 * WebKit both have it; without it the screen starts at 0, which is where the
 * only screen of most desktops starts. On Wayland a window can't know where
 * it is, so the window and the screen both start at 0 there.
 */
export function pageScreen(view: ScreenView | undefined = typeof window === "undefined" ? undefined : window): PageScreen | null {
  const seen = view?.screen;
  if (!seen || !finite(seen.availWidth) || !finite(seen.availHeight) || seen.availWidth <= 0 || seen.availHeight <= 0) return null;
  const left: unknown = Reflect.get(seen, "availLeft");
  return {
    left: finite(left) ? left : 0,
    width: seen.availWidth,
    height: seen.availHeight,
    windowLeft: finite(view?.screenX) ? view.screenX : 0,
    windowWidth: finite(view?.outerWidth) && view.outerWidth > 0 ? view.outerWidth : 0,
  };
}

/**
 * The screen's span in the shell's logical pixels, placed around the window:
 * `win` is the window's left edge and outer width there.
 *
 * Only distances from the window are carried over, never the page's own
 * origin. With two screens at different scales, Windows' engine lays its
 * screens out in its own way, and its origins don't match the shell's
 * physical-over-scale ones, but a distance on one screen means the same on
 * both sides. The page's screen pixels are the desktop's logical ones on the
 * engines Linger runs on, which an interface zoom leaves alone; if an engine
 * ever counted them zoomed, the window's outer width (counted the same way)
 * gives the ratio. A ratio past any real zoom means a number is off, and
 * then none is used.
 */
export function screenAround(win: { x: number; width: number }, seen: PageScreen): Span {
  const ratio = seen.windowWidth > 0 && win.width > 0 ? win.width / seen.windowWidth : 1;
  const k = ratio >= 0.5 && ratio <= 4 ? ratio : 1;
  return { x: win.x - (seen.windowLeft - seen.left) * k, width: seen.width * k };
}
