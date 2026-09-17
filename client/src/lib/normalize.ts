/**
 * "Normalize everyone" (SPEC §4.5, constraint 5).
 *
 * Some people will want the room quiet — every name in the reader's own default
 * style, no gradients, no shimmer, no characterful faces, and message fonts
 * flattened with them. Give it to them without friction.
 *
 * This is the reader's preference about their own screen, not something anyone
 * else can see, so it lives here and in local storage rather than in the gateway
 * store. The whole
 * of the effect is one attribute on `<html>`: `styles/names.css` has rules that
 * outrank every per-person value, so nothing that draws a name has to know this
 * switch exists.
 */
const KEY = "linger.normalize";

/** The saved answer, or off. Reading storage can throw; that is fine. */
export function loadNormalize(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

/** Apply it to the document and remember it for next launch. */
export function applyNormalize(on: boolean): void {
  if (on) {
    document.documentElement.dataset.normalize = "true";
  } else {
    delete document.documentElement.dataset.normalize;
  }
  try {
    window.localStorage.setItem(KEY, String(on));
  } catch {
    // A browser with storage switched off still gets the setting this session.
  }
}
