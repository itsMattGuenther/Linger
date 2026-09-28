/**
 * Where something that floats goes beside what opened it (lessons L-06 and
 * L-11): one rule for every menu and list in the kit, so none of them can
 * cover its trigger or run off the window.
 */

/** Distance from the trigger, and the closest a floating box may come to the window's edge. */
export const GAP = 4;
export const EDGE = 8;

/** What it floats beside: the trigger's box in the window. */
export interface Anchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface Placement {
  top: number;
  left: number;
  /**
   * The most height it may take where it went. Only less than its own height
   * when the window has no room for it either way; a list then scrolls
   * rather than run off the edge or over its trigger.
   */
  room: number;
}

/**
 * Below the anchor, or above when there's no room below. With no room
 * either way, it takes the side with more. Its `start` or `end` edge lines
 * up with the anchor's, and it always stays inside the window.
 *
 * `view` is the window's size; it's a parameter so the rule can be tested
 * without one.
 */
export function placeBeside(
  anchor: Anchor,
  size: { width: number; height: number },
  align: "start" | "end",
  view: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): Placement {
  const roomBelow = Math.max(0, view.height - EDGE - (anchor.bottom + GAP));
  const roomAbove = Math.max(0, anchor.top - GAP - EDGE);
  const below = size.height <= roomBelow || (size.height > roomAbove && roomBelow >= roomAbove);
  const room = below ? roomBelow : roomAbove;
  const height = Math.min(size.height, room);
  const top = below ? anchor.bottom + GAP : anchor.top - GAP - height;
  const wanted = align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.max(EDGE, Math.min(wanted, view.width - EDGE - size.width));
  return { top, left, room };
}
