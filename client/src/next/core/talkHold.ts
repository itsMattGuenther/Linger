/**
 * Who is holding the push-to-talk key down (SPEC §4.14, #500): the windows
 * that heard it go down, and the desktop shell's watcher, which hears it with
 * any app in front (`src-tauri/src/talk_key`). The list window keeps one of
 * these, and the microphone is open while anybody holds the key.
 *
 * The same press is often heard twice, by a Linger window in front and by
 * the watcher, and counts once. There is only one key, so whoever hears it
 * come up first closes the microphone. A window losing focus, or closing, or
 * the watcher stopping, lets go of only what it heard itself: switching to a
 * game with the key held keeps talking where the watcher reaches, and closes
 * the microphone where it doesn't.
 */

/** Where a press was heard: a window's label, or the shell's watcher. */
export type TalkFrom = string;

/** The shell's watcher: the key heard whatever app is in front. */
export const ANYWHERE: TalkFrom = "anywhere";

/**
 * What was heard: the key went `down`, came `up`, or the one hearing it went
 * `away` (a window lost focus or closed, the watcher stopped).
 */
export type TalkEdge = "down" | "up" | "away";

export type TalkHolders = ReadonlySet<TalkFrom>;

export const NOBODY: TalkHolders = new Set();

/** The holders after `from` heard `edge`. */
export function heard(holders: TalkHolders, from: TalkFrom, edge: TalkEdge): TalkHolders {
  if (edge === "up") return NOBODY;
  if (edge === "down") return holders.has(from) ? holders : new Set([...holders, from]);
  if (!holders.has(from)) return holders;
  const left = new Set(holders);
  left.delete(from);
  return left;
}

/** Whether the key counts as held: somebody heard it go down and nobody heard it come up. */
export function held(holders: TalkHolders): boolean {
  return holders.size > 0;
}
