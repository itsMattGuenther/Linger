import { type RefObject, useEffect, useLayoutEffect, useReducer, useState } from "react";

/** Space kept between a card, what opened it and the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * Where a card from the voice bar sits: just above what opened it (the bar
 * is at the bottom of the list), lined up with its left edge, never off the
 * window. `body` is an element inside the card's `Popover`; the card is its
 * parent. Measured on every draw, before it is painted: the voice bar grows
 * and shrinks as people come and go, and the opener moves with it.
 */
export function useAbove(anchor: RefObject<HTMLElement | null>, body: RefObject<HTMLElement | null>): { x: number; y: number } {
  const [at, setAt] = useState({ x: EDGE, y: EDGE });
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    const card = body.current?.parentElement;
    // An opener that's gone (a big room's seat taken by somebody new, #197)
    // measures as the window's corner: the card stays where it was instead.
    const node = anchor.current;
    if (!card || !node || !node.isConnected) return;
    const opener = node.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = card;
    const y = Math.max(EDGE, Math.round(opener.top) - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(opener.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  });
  useEffect(() => {
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, []);
  return at;
}
