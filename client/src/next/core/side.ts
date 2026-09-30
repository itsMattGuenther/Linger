/**
 * The list window's side: conversations open beside the list, in the same
 * window (#337, docs/design/buddy-list.md, "Conversations beside the list").
 * The window unfolds to show them and folds back to just the list. Kept on
 * this computer: whether it's unfolded, and how wide the list and the pane
 * were last, so each comes back the size it was. Pure, so every size is
 * tested without a window.
 *
 * Widths here are the page's own pixels (CSS px, before interface size
 * zooms them); the list window turns them into the desktop's.
 */

/** The list on its own, as `tauri.conf.json` opens it. */
export const LIST_WIDTH = 340;
/** The narrowest the list window may be (`tauri.conf.json`, `minWidth`). */
export const LIST_MIN = 300;
/**
 * The widest the list is kept beside a conversation, dragged or not. A list
 * folded on a wide tile (a tiling desktop sizes the window, not Linger) is
 * still a list.
 */
export const LIST_MAX = 560;
/** A conversation's room, as the chat window opened it. */
export const PANE_WIDTH = 780;
/** Narrower than this and the conversation takes the window rather than sit beside the list. */
export const PANE_MIN = 420;

export interface Side {
  /** The conversations are showing beside the list. */
  unfolded: boolean;
  /** The list's width beside them. */
  list: number;
  /** The conversations' width. */
  pane: number;
}

export const FOLDED: Side = { unfolded: false, list: LIST_WIDTH, pane: PANE_WIDTH };

/** The part of `Storage` this needs, so tests can hand it a plain one. */
export interface SideStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "linger.next.side";

function clamp(value: number, low: number, high: number): number {
  return Math.round(Math.min(high, Math.max(low, value)));
}

export function listWidth(width: number): number {
  return clamp(width, LIST_MIN, LIST_MAX);
}

export function paneWidth(width: number): number {
  return Math.round(Math.max(PANE_MIN, width));
}

/** As left last time; folded, at the designed sizes, if nothing readable was kept. */
export function loadSide(store: SideStore | null): Side {
  let parsed: unknown;
  try {
    parsed = JSON.parse(store?.getItem(KEY) ?? "null");
  } catch {
    return FOLDED;
  }
  if (typeof parsed !== "object" || parsed === null) return FOLDED;
  const unfolded: unknown = Reflect.get(parsed, "unfolded");
  const list: unknown = Reflect.get(parsed, "list");
  const pane: unknown = Reflect.get(parsed, "pane");
  return {
    unfolded: unfolded === true,
    list: typeof list === "number" && Number.isFinite(list) ? listWidth(list) : LIST_WIDTH,
    pane: typeof pane === "number" && Number.isFinite(pane) ? paneWidth(pane) : PANE_WIDTH,
  };
}

export function saveSide(store: SideStore | null, side: Side): void {
  try {
    store?.setItem(KEY, JSON.stringify(side));
  } catch {
    // Storage refused: it comes back folded, at the designed sizes.
  }
}

/**
 * How a window this wide shows the list and a conversation. Side by side
 * while both fit, the list at the width it was left at, or narrower where
 * the window can't spare it: the conversation keeps at least `PANE_MIN`.
 * Too narrow even for the narrowest list (a narrow tile, a small screen),
 * the conversation takes the whole window, with a way back to the list.
 */
export function beside(windowWidth: number, list: number): { layout: "beside" | "over"; list: number } {
  if (windowWidth < LIST_MIN + PANE_MIN) return { layout: "over", list };
  return { layout: "beside", list: Math.round(Math.max(LIST_MIN, Math.min(list, windowWidth - PANE_MIN, LIST_MAX))) };
}

/** How wide the list may be dragged in a window this wide (`Splitter`): the conversation keeps its room. */
export function widestList(windowWidth: number): number {
  return Math.max(LIST_MIN, Math.min(LIST_MAX, windowWidth - PANE_MIN));
}

/** A window's or a screen's left edge and width, in the desktop's pixels. */
export interface Span {
  x: number;
  width: number;
}

/**
 * Unfolding: how wide the window becomes, and where it moves so the new part
 * stays on its screen (it grows to the right, and leftwards where the screen
 * ends). Null when it's wide enough already, as a maximized window or a wide
 * tile is. `zoom` turns the page's pixels into the desktop's.
 */
export function unfolding(win: Span, screen: Span | null, side: Side, zoom: number): { width: number; x: number | null } | null {
  if (win.width >= (side.list + PANE_MIN) * zoom) return null;
  const width = Math.round((side.list + side.pane) * zoom);
  if (screen === null) return { width, x: null };
  const right = screen.x + screen.width;
  if (win.x + width <= right) return { width, x: null };
  return { width: Math.min(width, screen.width), x: Math.max(screen.x, right - width) };
}

/** Folding: back to the list's width, in the desktop's pixels. */
export function folding(side: Side, zoom: number): number {
  return Math.round(side.list * zoom);
}
