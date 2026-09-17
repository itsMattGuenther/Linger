/**
 * Dark, light, and the warmth that arrives after sunset (SPEC §4.7, §5.3).
 *
 * Two preferences, both the reader's own and neither of them anybody else's
 * business, so they live here and in local storage like the other display preferences. Both
 * are one attribute on `<html>` and a block of custom properties in
 * `styles/tokens.css` — no second stylesheet, and nothing that draws anything
 * knows which theme it is in.
 *
 * **About "sunset".** The spec says the shift happens after local sunset, and
 * the honest way to know that is a latitude and a longitude. This app does not
 * ask for those and is not going to: a chat client that wants your coordinates
 * to tint its background has made a bad trade. So sunset is approximated by the
 * clock — warm in the evening, cool again in the morning, on the reader's own
 * local time. It is wrong by up to a couple of hours in June and December at
 * high latitudes, and the whole effect is a 200K tint that most people will
 * never consciously notice, which is the reason that is an acceptable trade and
 * a location permission is not.
 */
export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_PREFS: readonly ThemePref[] = ["dark", "light", "system"];

const THEME_KEY = "linger.theme";
const WARMTH_KEY = "linger.warmth";

/** Warm from this hour of the local evening… */
const WARM_FROM_HOUR = 19;
/** …until this hour of the local morning. */
const WARM_UNTIL_HOUR = 7;

function isThemePref(value: string | null): value is ThemePref {
  return value !== null && THEME_PREFS.some((pref) => pref === value);
}

/** The saved preference, or "system". Reading storage can throw; that is fine. */
export function loadTheme(): ThemePref {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return isThemePref(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** Whether the warmth shift is wanted at all. On unless it was turned off. */
export function loadWarmth(): boolean {
  try {
    return window.localStorage.getItem(WARMTH_KEY) !== "false";
  } catch {
    return true;
  }
}

/** What the OS asks for, for the "system" preference. Dark when it has no view. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The theme a preference actually resolves to right now. */
export function resolveTheme(pref: ThemePref): Theme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Whether it is evening where the reader is.
 *
 * Takes the time rather than reading the clock so it can be tested, and so the
 * caller's one clock decides — the app already has a `useNow` tick and does not
 * need a second one.
 */
export function isEvening(now: Date): boolean {
  const hour = now.getHours();
  return hour >= WARM_FROM_HOUR || hour < WARM_UNTIL_HOUR;
}

/** Apply the theme to the document and remember the preference. */
export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // A browser with storage switched off still gets the theme this session.
  }
}

/**
 * Apply the warmth for a moment in time, and remember whether it is wanted.
 *
 * Off and "on but it is the middle of the afternoon" are the same document
 * state on purpose: there is one attribute, and it says whether the room is
 * warm right now, not why.
 */
export function applyWarmth(wanted: boolean, now: Date): void {
  if (wanted && isEvening(now)) {
    document.documentElement.dataset.warmth = "warm";
  } else {
    delete document.documentElement.dataset.warmth;
  }
  try {
    window.localStorage.setItem(WARMTH_KEY, String(wanted));
  } catch {
    // Same as above: this session still gets what was asked for.
  }
}

/**
 * Call `onChange` whenever the OS flips between light and dark.
 *
 * Only matters for the "system" preference, but it is wired unconditionally and
 * the caller re-applies whatever it has — one listener is cheaper than a
 * subscription that has to be torn down and rebuilt every time the preference
 * changes.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  let query: MediaQueryList;
  try {
    query = window.matchMedia("(prefers-color-scheme: light)");
  } catch {
    return () => {};
  }
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
