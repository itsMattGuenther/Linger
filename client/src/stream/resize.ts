import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

type Scroller = Pick<Virtualizer<HTMLDivElement, Element>, "scrollToIndex" | "getTotalSize">;

/** Reflow must not lift a reader off the live edge, or pull scrollback to it. */
export function useResizeAnchor(
  scrollElement: RefObject<HTMLDivElement | null>,
  virtualizer: Scroller,
  room: string,
  count: number,
  atEnd: boolean,
): void {
  const target = useRef({ count, atEnd });
  target.current = { count, atEnd };
  useLayoutEffect(() => {
    const element = scrollElement.current;
    if (!element) return;
    let width = element.clientWidth;
    let height = element.clientHeight;
    let pinned = element.scrollHeight - element.scrollTop - height <= 2;
    let settling = false;
    let pending = 0;
    const remember = () => {
      // WebKit can report its clamped scroll before ResizeObserver delivers
      // the new size. That is reflow, not a person leaving the live edge.
      if (settling || element.clientWidth !== width || element.clientHeight !== height) return;
      pinned = element.scrollHeight - element.scrollTop - height <= 2;
    };
    const release = () => {
      cancelAnimationFrame(pending);
      settling = false;
      pinned = false;
      // A click or an outward wheel at the end may not emit a scroll event.
      // Read again after the input's default action, without moving anything.
      pending = requestAnimationFrame(remember);
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) release();
    };
    const observer = new ResizeObserver(() => {
      const changed = width !== element.clientWidth || height !== element.clientHeight;
      width = element.clientWidth;
      height = element.clientHeight;
      if (!changed || !pinned || !target.current.atEnd || target.current.count === 0) return;
      cancelAnimationFrame(pending);
      settling = true;
      let frames = 0;
      let stable = 0;
      let previousTotal = -1;
      const step = () => {
        if (!target.current.atEnd || target.current.count === 0) {
          release();
          return;
        }
        virtualizer.scrollToIndex(target.current.count - 1, { align: "end" });
        const total = virtualizer.getTotalSize();
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        stable = atBottom && total === previousTotal ? stable + 1 : 0;
        previousTotal = total;
        frames += 1;
        if (stable >= 5 || frames >= 60) {
          settling = false;
          remember();
        } else pending = requestAnimationFrame(step);
      };
      // The first correction happens here, not a frame later. A resize
      // observer reports after layout but before paint, so scrolling now lands
      // in the same frame as the resize; waiting a frame paints one frame of
      // the conversation off the bottom, which reads as the whole window
      // blinking whenever something above it (the voice bar) changes height
      // (#142). Later frames only settle rows whose heights arrive late.
      step();
    });
    observer.observe(element);
    element.addEventListener("scroll", remember, { passive: true });
    element.addEventListener("wheel", release, { passive: true });
    element.addEventListener("touchstart", release, { passive: true });
    element.addEventListener("pointerdown", release, { passive: true });
    element.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(pending);
      element.removeEventListener("scroll", remember);
      element.removeEventListener("wheel", release);
      element.removeEventListener("touchstart", release);
      element.removeEventListener("pointerdown", release);
      element.removeEventListener("keydown", onKey);
    };
  }, [scrollElement, virtualizer, room]);
}
