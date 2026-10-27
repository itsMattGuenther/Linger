/**
 * A share that has gone black (#722, SPEC §4.20). A slide show runs in a
 * window of its own, so a shared window, PowerPoint's, comes out black for
 * everybody watching while the person showing it can't tell: the show covers
 * their whole screen, Linger too. So, about once a second, a small copy of
 * what's sent is looked at, here on this computer, only for whether it is
 * black. Nothing is kept or sent, and nothing asks what the picture is (hard
 * rule 2). Nor what was picked, a window or the whole screen (PRIV-2), so
 * every share is looked at, and the words say what to do if it was one
 * window: a black slide held on the whole screen says so too, once.
 *
 * The Linux shell looks the same way, at the same size and with the same
 * thresholds (`looks_black` in `src-tauri/src/screen_shell/linux.rs`).
 */

/** The copy that's looked at: small enough to read in no time, big enough that a line of text shows. */
export const LOOK_WIDTH = 160;
export const LOOK_HEIGHT = 90;
/** How often it's looked at. */
export const LOOK_EVERY_MS = 1_000;
/** How long it stays black before it's said: a slide show stays black, a cut to black between slides doesn't. */
export const BLACK_FOR_MS = 5_000;
/** The brightest a pixel of a black picture is, out of 255: black from a capture can come through as 16, not 0. */
export const BLACK_LEVEL = 24;
/** How many pixels of the copy may be brighter, one in a thousand: a pointer over the picture. */
export const LIT_AT_MOST = 0.001;

/**
 * Whether a picture is black: `pixels` is the copy, `channels` a pixel's
 * values one after another, 4 for RGBA (alpha not counted) or 1 for a
 * brightness alone.
 */
export function looksBlack(pixels: ArrayLike<number>, channels: 1 | 4): boolean {
  const count = Math.floor(pixels.length / channels);
  if (count === 0) return false;
  const allowed = Math.floor(count * LIT_AT_MOST);
  let lit = 0;
  for (let at = 0; at < count * channels; at += channels) {
    const brightest = channels === 1 ? (pixels[at] ?? 0) : Math.max(pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0);
    if (brightest > BLACK_LEVEL) {
      lit += 1;
      if (lit > allowed) return false;
    }
  }
  return true;
}

/**
 * The looks at one share, one after another: says when it has been black
 * for `BLACK_FOR_MS`, once a share. Anything not black starts it over.
 */
export class BlackWatch {
  #since: number | null = null;
  #said = false;

  /** A look at `at` (ms): true the one time the share has been black long enough. */
  look(at: number, black: boolean): boolean {
    if (!black) {
      this.#since = null;
      return false;
    }
    this.#since ??= at;
    if (this.#said || at - this.#since < BLACK_FOR_MS) return false;
    this.#said = true;
    return true;
  }
}

/** The desktop notice, said once a share: a slide show covers the app, so the box alone isn't seen. */
export const BLACK_NOTICE = {
  title: "Everyone watching sees a black screen",
  body: "If you're showing slides, stop sharing and share your entire screen, not just the PowerPoint window.",
} as const;
