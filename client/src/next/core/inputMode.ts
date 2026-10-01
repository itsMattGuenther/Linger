/**
 * How you last used this window, on the page's root as `data-input`:
 * "pointer" after a click, "keyboard" after a key (#375). The focus ring
 * follows it (styles/tokens.css, `--focus-ring`).
 *
 * The ring is for keyboard users, and the browser's `:focus-visible` decides
 * it as focus arrives. Coming back to the window, from another workspace or
 * with Alt+Tab, WebKitGTK puts focus back where it was and calls that
 * keyboard focus, so the ring lit up on whatever you'd last clicked. Coming
 * back is neither a click nor a key in the page (the compositor keeps its
 * shortcuts), so it leaves this as it was.
 *
 * A modifier on its own (Shift, Super, Control) is not using the keyboard:
 * it's half of a shortcut, often the desktop's, and the page may see it go
 * down before the desktop takes the rest. Nothing is set until the first
 * click or key, so the ring shows as the browser decides until then.
 */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock"]);

/** The page's root, as far as this needs it. */
export interface InputRoot {
  dataset: DOMStringMap;
}

export function followInputMode(root: InputRoot, page: EventTarget): () => void {
  const pointer = () => {
    root.dataset.input = "pointer";
  };
  const key = (event: Event) => {
    const name = "key" in event && typeof event.key === "string" ? event.key : "";
    if (MODIFIERS.has(name)) return;
    root.dataset.input = "keyboard";
  };
  // Capturing, so a handler that stops the event further in can't hide it.
  page.addEventListener("pointerdown", pointer, { capture: true });
  page.addEventListener("keydown", key, { capture: true });
  return () => {
    page.removeEventListener("pointerdown", pointer, { capture: true });
    page.removeEventListener("keydown", key, { capture: true });
  };
}
