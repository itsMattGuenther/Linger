/**
 * Full screen for a shared screen (SPEC §4.20, #360): the window itself fills
 * the monitor, and the screen fills the window. In the desktop app it's the
 * window's own full screen, which a tiling desktop honours too; in a page
 * without the app around it (the test pages), the page's.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function setWindowFull(on: boolean): Promise<void> {
  try {
    if (isTauri()) {
      await getCurrentWindow().setFullscreen(on);
      return;
    }
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Refused: the screen still fills the window.
  }
}

/**
 * Call `left` when the page's own full screen ends without the app asking:
 * Escape there is the engine's, and the app never hears the key. The
 * desktop app's window full screen has no such way out, so it hears Escape.
 */
export function onPageFullscreenLeft(left: () => void): () => void {
  if (isTauri()) return () => undefined;
  const changed = () => {
    if (!document.fullscreenElement) left();
  };
  document.addEventListener("fullscreenchange", changed);
  return () => document.removeEventListener("fullscreenchange", changed);
}
