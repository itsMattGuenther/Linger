/**
 * The app's color themes (SPEC §5.3, #963, #964): which there are, the one
 * this computer or phone has chosen, and putting it on the page.
 *
 * A theme is a set of values for the color tokens (`styles/tokens.css`, a
 * `[data-theme="<id>"]` block each, The door on `:root`). It's chosen per
 * device and never sent anywhere. It's kept and announced to every window
 * like the interface size (`core/appearance.ts`), and a choice storage
 * refuses isn't made (#782).
 *
 * The page puts the saved theme on before it draws, from `public/theme.js`,
 * which `next.html` runs first: the app's own code is a module, which runs
 * only after the page could have drawn The door for a moment. That file
 * repeats the key and the ids below as plain JavaScript, and `theme.test.ts`
 * holds the two together.
 */

/** Every theme Settings offers, in its order, with the name it shows. */
export const THEMES = [
  { id: "door", name: "The door" },
  { id: "after-dark", name: "After dark" },
  { id: "porch-light", name: "Porch light" },
  { id: "dusk", name: "Dusk" },
  { id: "original", name: "The original" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** Today's colors, and what a computer that has chosen nothing gets. */
export const DEFAULT_THEME: ThemeId = "door";

/** Where the choice is kept on this computer or phone. `public/theme.js` reads it too. */
export const THEME_KEY = "linger.next.theme";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

/** The theme chosen here; The door for nothing saved, a theme that's gone, or storage that won't answer. */
export function loadTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return isThemeId(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Save a theme; announce it with `announceAppearance`. Says whether storage took it. */
export function saveTheme(theme: ThemeId): boolean {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    // Storage refused: nothing changes, and Settings says so (#782).
    return false;
  }
}

/** Put a theme on the page: every color token follows `data-theme` on `<html>`. */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}
