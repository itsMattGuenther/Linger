/**
 * The window buttons Linger draws beside its close button (#386). Every
 * Linger window is frameless and draws its own title bar
 * (docs/design/architecture.md, Title bars), so the desktop draws no buttons
 * on it. On Windows every window has a minimize button, and Linger draws one.
 * Elsewhere it doesn't: a tiling Linux desktop has no minimizing, so the
 * button would do nothing, and the rest of Linux keeps its keyboard
 * shortcuts.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The Windows app, whose engine, WebView2, names Windows in its user agent. */
export function drawsMinimize(userAgent: string, desktop: boolean): boolean {
  return desktop && /\bWindows\b/.test(userAgent);
}

/** Minimizes this window, where Linger draws the button, and nothing anywhere else. */
export function minimizer(): (() => void) | undefined {
  return drawsMinimize(navigator.userAgent, isTauri()) ? () => void getCurrentWindow().minimize() : undefined;
}
