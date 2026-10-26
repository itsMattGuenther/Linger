import { observeElementOffset, type Virtualizer } from "@tanstack/react-virtual";

/**
 * The virtualizer's own watch on how far a conversation is scrolled, except
 * that when the scrolling stops, it says where the conversation is then, not
 * where it was at the last scroll event (#716).
 *
 * In between, the virtualizer may have moved the conversation itself: a page
 * of older history going in above moves the reader down by its height, to
 * keep their place. On a busy computer that move's own scroll event hadn't
 * come yet when the stop was said. The virtualizer took the old position for
 * where the conversation was, corrected the next row it measured from there,
 * and the reader was thrown a page up into older history.
 * `@tanstack/virtual-core` 3.17.11 makes the same change; this can go once
 * the client is on it.
 */
export function observeScrollNow(
  instance: Virtualizer<HTMLDivElement, Element>,
  report: (offset: number, isScrolling: boolean) => void,
): (() => void) | undefined {
  return observeElementOffset(instance, (offset, isScrolling) => {
    report(isScrolling ? offset : (instance.scrollElement?.scrollTop ?? offset), isScrolling);
  });
}
