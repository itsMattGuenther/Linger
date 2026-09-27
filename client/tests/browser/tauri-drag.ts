/**
 * Tauri's own rule for which presses move a window, copied from the Tauri the
 * desktop shell is built with (`tauri/src/window/scripts/drag.js`, which the
 * shell injects into every page). A browser has no Tauri, so without this a
 * test can't tell whether a press on a title bar would move the window, and
 * the tabs window shipped with a title bar that almost no press could move
 * (#225).
 *
 * The rule, in short: a press moves the window when, walking up from what
 * was pressed, it meets `data-tauri-drag-region` before any control (a
 * button, a link, a field, a tab, anything focusable). A bare attribute
 * counts only for a press on that very element, not on anything inside it;
 * `"deep"` counts for everything inside; `"false"` stops the walk.
 *
 * `installTauriDrag` goes to `page.addInitScript`. It listens for presses the
 * way Tauri does, but writes down what Tauri would have asked the shell for
 * (`start_dragging`, or `internal_toggle_maximize` on a double press) in
 * `window.tauriDrags` instead of asking. `window.tauriMoves(element)` says
 * whether a press on `element` would move the window.
 *
 * When Tauri is upgraded, compare its drag.js with this copy, then update
 * the copy and `TAURI_DRAG_VERSION`. A test in the desktop shell
 * (`the_title_bar_tests_know_the_tauri_they_copy`, src-tauri/src/window.rs)
 * fails until the version here matches `client/src-tauri/Cargo.lock`.
 */
export const TAURI_DRAG_VERSION = "2.11.5";

declare global {
  interface Window {
    /** What Tauri would have asked the shell for, press by press. */
    tauriDrags?: string[];
    /** Whether a press on this element would move the window. */
    tauriMoves?: (element: Element) => boolean;
  }
}

/** Runs in the page before its own scripts, like Tauri's. Self-contained: Playwright sends it as source. */
export function installTauriDrag(): void {
  const ATTR = "data-tauri-drag-region";
  const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

  const isClickable = (el: HTMLElement): boolean =>
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "");

  const isDragRegion = (path: readonly EventTarget[]): boolean => {
    for (const el of path) {
      if (!(el instanceof HTMLElement)) continue;
      const attr = el.getAttribute(ATTR);
      if (isClickable(el) && attr === null) return false;
      if (attr === null) continue;
      if (attr === "false") return false;
      if (attr === "deep") return true;
      if (attr === "" || attr === "true") return el === path[0];
    }
    return false;
  };

  const drags: string[] = [];
  window.tauriDrags = drags;
  window.tauriMoves = (element) => {
    const path: Element[] = [];
    for (let at: Element | null = element; at; at = at.parentElement) path.push(at);
    return isDragRegion(path);
  };
  document.addEventListener("mousedown", (event) => {
    if (event.button === 0 && (event.detail === 1 || event.detail === 2) && isDragRegion(event.composedPath())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      drags.push(event.detail === 2 ? "internal_toggle_maximize" : "start_dragging");
    }
  });
}
