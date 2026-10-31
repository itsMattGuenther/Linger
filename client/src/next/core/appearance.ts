/**
 * How the new client looks on this computer, the same in every window: plain
 * names (NAME-4), interface size (LOOK-1) and one line per person in the
 * list (#197). Settings saves a change and
 * announces it; every window applies it at once, and each applies what's
 * saved when it opens.
 *
 * A choice storage refuses (full, or switched off) still holds until Linger
 * closes (#782). Each window keeps the choices made or announced in it and
 * reads them before storage, the announcement carries them, and a window
 * opened later asks the list for the ones it has heard, as the list is open
 * from start to quit.
 *
 * Interface size zooms the whole page, like a browser's zoom, because the new
 * client's sizes are fixed pixels (docs/design/system.md) and a larger base
 * font would grow nothing. A window grows by the same ratio, so its layout
 * keeps the width it was designed at: a list at 150% is 510 wide, not 340
 * wide with a 227-pixel layout squeezed into it.
 *
 * The desktop shell remembers each window's size between runs
 * (`remembered_windows` in src-tauri/src/window.rs), so each window also
 * remembers which interface size it was last sized for and only grows or
 * shrinks by the difference: a window remembered at 150% opens at 150% and
 * doesn't grow again.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { validScale, validTextSize } from "../../lib/interface";
import { applyNormalize, loadNormalize } from "../../lib/normalize";
import { answer, ask, isOwner, OWNER, PROTOCOL, tauriBus } from "./bus";
import { onPhone } from "./phone";
import { pageScreen } from "./screen";

/** Settings changed how things look; every window keeps the choices it carries, and applies them. */
export const APPEARANCE = "next:appearance";
/** A window opened after a change asks the list for the choices it has heard. */
export const APPEARANCE_CHOSEN = "next:appearancechosen";

/** The choices Settings makes, as its announcement carries them. */
interface Choices {
  scale: number;
  oneLine: boolean;
  hideReactions: boolean;
  plainNames: boolean;
}

/**
 * The choices made or announced in this window, read before storage
 * (#782). Settings shows the choice it made, but every window applies what
 * it reads back, so a choice storage refused showed and applied nowhere.
 */
const chosen: Partial<Choices> = {};

/** The same key the previous client used, so an update keeps the size. */
const SCALE_KEY = "linger.interface.scale";

export function loadScale(): number {
  if (chosen.scale !== undefined) return chosen.scale;
  try {
    return validScale(Number(window.localStorage.getItem(SCALE_KEY)));
  } catch {
    return 100;
  }
}

/** Save an interface size; anything not on the list is 100. Returns what was saved. */
export function saveScale(value: number): number {
  const scale = validScale(value);
  chosen.scale = scale;
  try {
    window.localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    // Storage refused: `chosen` holds it until Linger closes.
  }
  return scale;
}

/** The phone's own Text size (#690), a percentage on top of the phone's text size. */
const TEXT_SIZE_KEY = "linger.next.textSize";

/**
 * The Text size chosen here, kept beside storage so a choice storage refuses
 * still applies until the app closes (#780's review). `followTextSize` reads
 * it back through `loadTextSize`, and the phone has one window, so nothing
 * else changes it meanwhile.
 */
let chosenTextSize: number | null = null;

export function loadTextSize(): number {
  if (chosenTextSize !== null) return chosenTextSize;
  try {
    return validTextSize(Number(window.localStorage.getItem(TEXT_SIZE_KEY)));
  } catch {
    return 100;
  }
}

/** Save the phone's Text size; anything not on the list is 100. Returns what was saved. */
export function saveTextSize(value: number): number {
  const size = validTextSize(value);
  chosenTextSize = size;
  try {
    window.localStorage.setItem(TEXT_SIZE_KEY, String(size));
  } catch {
    // Storage refused: `chosenTextSize` holds it until the app closes.
  }
  return size;
}

/** One line per person in the list (#197): off unless turned on. */
const ONE_LINE_KEY = "linger.next.peopleOneLine";

export function loadOneLine(): boolean {
  if (chosen.oneLine !== undefined) return chosen.oneLine;
  try {
    return window.localStorage.getItem(ONE_LINE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Save one line per person; announce it with `announceAppearance`. */
export function saveOneLine(on: boolean): void {
  chosen.oneLine = on;
  try {
    window.localStorage.setItem(ONE_LINE_KEY, String(on));
  } catch {
    // Storage refused: `chosen` holds it until Linger closes.
  }
}

/** Reactions hidden on this computer (#485): shown unless turned off. */
const HIDE_REACTIONS_KEY = "linger.next.hideReactions";

export function loadHideReactions(): boolean {
  if (chosen.hideReactions !== undefined) return chosen.hideReactions;
  try {
    return window.localStorage.getItem(HIDE_REACTIONS_KEY) === "true";
  } catch {
    return false;
  }
}

/** Save hiding reactions; announce it with `announceAppearance`. */
export function saveHideReactions(hidden: boolean): void {
  chosen.hideReactions = hidden;
  try {
    window.localStorage.setItem(HIDE_REACTIONS_KEY, String(hidden));
  } catch {
    // Storage refused: `chosen` holds it until Linger closes.
  }
}

/** Plain names, as chosen or announced here, else as saved (`lib/normalize.ts`). */
export function loadPlainNames(): boolean {
  return chosen.plainNames ?? loadNormalize();
}

/** Plain names: applied to this window, and saved for the others. */
export function saveNormalize(on: boolean): void {
  chosen.plainNames = on;
  applyNormalize(on);
}

/**
 * Keep the choices another window sent, as if made here: Settings'
 * announcement, or the list's answer to a window opened since. Says whether
 * there was any.
 */
function keep(sent: unknown): boolean {
  if (typeof sent !== "object" || sent === null) return false;
  const { scale, oneLine, hideReactions, plainNames } = sent as Record<string, unknown>;
  const taken: Partial<Choices> = {};
  if (typeof scale === "number") taken.scale = validScale(scale);
  if (typeof oneLine === "boolean") taken.oneLine = oneLine;
  if (typeof hideReactions === "boolean") taken.hideReactions = hideReactions;
  if (typeof plainNames === "boolean") taken.plainNames = plainNames;
  Object.assign(chosen, taken);
  return Object.keys(taken).length > 0;
}

/** A window's size after a change of interface size: grown or shrunk by the same ratio. */
export function resizedFor(size: { width: number; height: number }, from: number, to: number): { width: number; height: number } {
  const ratio = to / from;
  return { width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) };
}

/**
 * The smallest each window may be at 100%, as the desktop shell builds it:
 * the list in `src-tauri/tauri.conf.json`, the others in
 * `src-tauri/src/window.rs`. `appearance.test.ts` reads both, so the numbers
 * here can't drift from them.
 */
export const WINDOW_MINIMUMS = {
  list: { width: 300, height: 480 },
  chat: { width: 360, height: 360 },
  settings: { width: 560, height: 480 },
  tool: { width: 360, height: 420 },
} as const;

/** Which of `WINDOW_MINIMUMS` a window is, by the label the shell gave it. */
export function windowKind(label: string): keyof typeof WINDOW_MINIMUMS {
  if (label === "settings") return "settings";
  if (label === "search" || label === "media") return "tool";
  if (label.startsWith("chat-")) return "chat";
  return "list";
}

/**
 * A window's smallest size at an interface size (#512): the one it was
 * designed at, grown by the same ratio as the page, so the page is never
 * squeezed below the width its layout was made for. At 150% the list's 300
 * would otherwise be 200 of the page's pixels, and the message box over it
 * an 8 px slot. Never more than nine tenths of the screen, so a big size on
 * a small screen still leaves a window that fits on it.
 */
export function scaledMinimum(
  designed: { width: number; height: number },
  scale: number,
  screen: { width: number; height: number } | null,
): { width: number; height: number } {
  const grown = resizedFor(designed, 100, scale);
  if (!screen) return grown;
  return {
    width: Math.min(grown.width, Math.floor(screen.width * 0.9)),
    height: Math.min(grown.height, Math.floor(screen.height * 0.9)),
  };
}

/** The zoom this page has; a page opens at 100. */
let zoomed = 100;

/** Which interface size a window's size was last made for, kept per window. */
function sizedForKey(label: string): string {
  return `linger.next.windowScale.${label}`;
}

/**
 * The same, as made in this run, read before storage: a window grown for a
 * choice storage refused would otherwise read the old size back and be grown
 * again the next time it's applied (#782).
 */
const sizedHere = new Map<string, number>();

/**
 * Apply what's saved to this window, one run at a time. Two at once (Settings
 * applies a change and also hears its own announcement) would each read the
 * window's size before the other had grown it, and grow it twice. A call made
 * during a run waits for it, and one more run then applies what's saved by
 * then.
 */
let running: Promise<void> | null = null;
let again = false;
/** What a window draws from these choices itself, told when they're applied. */
const listeners = new Set<() => void>();

/**
 * Hear every time this window applies what's saved: a choice a screen draws
 * from rather than the page's CSS, like one line per person (#197). Returns
 * how to stop.
 */
export function onAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyAppearance(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  const run = (async () => {
    do {
      again = false;
      await applyOnce();
    } while (again);
  })();
  running = run.finally(() => {
    running = null;
  });
  return running;
}

async function applyOnce(): Promise<void> {
  applyNormalize(loadPlainNames());
  for (const listener of listeners) listener();
  const scale = loadScale();
  if (!isTauri()) return;
  const current = getCurrentWindow();
  try {
    if (zoomed !== scale) {
      zoomed = scale;
      await getCurrentWebview().setZoom(scale / 100);
    }
    // Before any resize: a smaller window may need the old floor gone first.
    await keepMinimum(current.label, scale);
    let sizedFor = 100;
    try {
      sizedFor = sizedHere.get(current.label) ?? validScale(Number(window.localStorage.getItem(sizedForKey(current.label)) ?? "100"));
    } catch {
      // Storage refused: treat the window as its designed size.
    }
    if (sizedFor === scale) return;
    const factor = await current.scaleFactor();
    const inner = (await current.innerSize()).toLogical(factor);
    const next = resizedFor(inner, sizedFor, scale);
    await current.setSize(new LogicalSize(next.width, next.height));
    sizedHere.set(current.label, scale);
    try {
      window.localStorage.setItem(sizedForKey(current.label), String(scale));
    } catch {
      // Storage refused: `sizedHere` holds it for this run, and the next
      // sizes it from its designed size again.
    }
  } catch {
    // A desktop that won't resize (a tiling one) still gets the zoom.
  }
}

/**
 * The window's smallest size, grown with the interface size (#512). A phone's
 * screen is the window, so it has none. A desktop that ignores it (a tiling
 * one) still gets the zoom and the resize.
 *
 * The screen's size is the page's own (`core/screen.ts`), never the shell's
 * `currentMonitor()`, which crashed the packaged Linux app (#623). An engine
 * that shrinks the screen by the page's zoom only makes the floor smaller,
 * the safe way to be wrong.
 */
async function keepMinimum(label: string, scale: number): Promise<void> {
  if (onPhone()) return;
  try {
    const shown = pageScreen();
    const screen = shown ? { width: shown.width, height: shown.height } : null;
    const least = scaledMinimum(WINDOW_MINIMUMS[windowKind(label)], scale, screen);
    await getCurrentWindow().setMinSize(new LogicalSize(least.width, least.height));
  } catch {
    // Refused or not offered: the window keeps the shell's floor.
  }
}

/** Tell every window, this one included, to apply what's now saved and the choices made here. */
export function announceAppearance(): void {
  void applyAppearance();
  if (isTauri()) void tauriBus().broadcast(APPEARANCE, { v: PROTOCOL, chosen: { ...chosen } });
}

/**
 * Apply what's saved now, and again whenever Settings announces a change,
 * keeping the choices it carries. The list answers a window opened later
 * with the ones it has heard, which that window keeps unless an
 * announcement reached it first, as that's newer.
 */
export function followAppearance(): void {
  void applyAppearance();
  if (!isTauri()) return;
  const bus = tauriBus();
  let heard = false;
  void bus.listen<{ v: number; chosen?: unknown }>(APPEARANCE, (message) => {
    if (message.v !== PROTOCOL) return;
    heard = true;
    keep(message.chosen);
    void applyAppearance();
  });
  if (isOwner(bus)) {
    void answer<object, Partial<Choices>>(bus, APPEARANCE_CHOSEN, async () => ({ ...chosen }));
    return;
  }
  void ask<unknown>(bus, OWNER, APPEARANCE_CHOSEN, {})
    .then((held) => {
      if (!heard && keep(held)) void applyAppearance();
    })
    .catch(() => undefined);
}
