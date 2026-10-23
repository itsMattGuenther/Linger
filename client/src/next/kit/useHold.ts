import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { startHold } from "../core/hold";

/** The handlers `useHold` hands back, to spread on the element that holds. */
export interface HoldProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onMouseDownCapture: (event: MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * Something held with a finger for its actions, on the phone (SPEC §4.15),
 * where nothing hovers to show them (#704): a list row, a server's header.
 * The hold is the page's own, timed as a message's is (`core/hold.ts`,
 * #686), because the iPhone's web view sends no long-press for a finger;
 * Android's, which does, is the same hold.
 *
 * The handlers go on an element that holds, in React's tree, both what's
 * held and what the hold raises: a `Menu` sheet is drawn in a portal, but
 * it's still that element's child, so the click a lifted finger leaves
 * behind on it is caught here and chooses nothing. `holds` says whether a
 * press landed on the thing held; any other press, a mouse's included,
 * starts afresh, so the tap after it is a tap. Off (`on` false), it hands
 * back nothing and the element is a plain one.
 */
export function useHold(onHold: () => void, holds: (target: Element) => boolean, on: boolean): HoldProps | undefined {
  const latest = useRef({ onHold, holds });
  latest.current = { onHold, holds };
  const [press] = useState(() => startHold(() => latest.current.onHold()));
  // Forgotten when what's held goes, and when it can't be held any more.
  useEffect(() => () => press.stop(), [press, on]);
  if (!on) return undefined;
  const here = (target: EventTarget) => target instanceof Element && latest.current.holds(target);
  return {
    onPointerDown: (event) => {
      if (event.pointerType === "mouse" || !here(event.target)) press.stop();
      else press.down(event.pointerId, event.clientX, event.clientY);
    },
    onPointerMove: (event) => press.move(event.pointerId, event.clientX, event.clientY),
    onPointerUp: (event) => press.end(event.pointerId),
    // The browser took the finger over to scroll.
    onPointerCancel: (event) => press.end(event.pointerId),
    // The mouse-down a web view makes up as a held finger lifts would take
    // the focus out of the sheet that rose under it.
    onMouseDownCapture: (event) => {
      if (press.afterHold()) event.preventDefault();
    },
    // And its click isn't a tap on what's under the finger now. One from
    // the keyboard (no presses, `detail` 0) always is.
    onClickCapture: (event) => {
      if (event.detail === 0 || !press.takeClick()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    // The phone's own long-press is this hold, not its menu; with no press
    // of a finger (the keyboard's menu key), it's the hold all the same.
    onContextMenu: (event) => {
      if (!here(event.target)) return;
      event.preventDefault();
      if (!press.now()) latest.current.onHold();
    },
  };
}
