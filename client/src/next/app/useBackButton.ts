import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri, type PluginListener } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { startEdgeSwipe } from "../core/edgeSwipe";
import { onIPhone, onPhone } from "../core/phone";

/**
 * How an iPhone's swipe in from the left edge goes back from something
 * (#697). Without one, nothing moves under the finger, and a swipe let go
 * of far enough over goes back: right for a card or a sheet, which don't
 * slide.
 */
export interface Swipe {
  /**
   * The screen being left, which follows the finger and slides off to the
   * right, showing what's under it (`[data-swipe]` and `--swipe-x` in
   * styles/phone.css). Null while there's none to move.
   */
  slide?: () => HTMLElement | null;
  /** False while a finger landing on it is its own, as on a zoomed photo. */
  now?: () => boolean;
}

interface Entry {
  back: () => void;
  swipe: Swipe;
}

/** What Back does now: the newest first (a picture over a conversation over the list). */
const handlers: Entry[] = [];
/** The one listener, while there's a handler, and which one it is. */
let listening: { id: number; held: Promise<PluginListener | null> } | null = null;
let listens = 0;
/** How to stop watching for an iPhone's swipe, while there's a handler. */
let watching: (() => void) | null = null;

function listen(): void {
  if (listening !== null) return;
  const id = ++listens;
  const held = onBackButtonPress(() => {
    // A listener being let go still hears a press on its way out.
    if (listening?.id === id) handlers.at(-1)?.back();
  }).catch(() => null);
  listening = { id, held };
}

function stopListening(): void {
  const was = listening;
  listening = null;
  void was?.held.then((held) => held?.unregister()).catch(() => undefined);
}

/** Longer than any slide takes (`--duration-slow`), for one whose end the page never hears. */
const SLIDE_MAX_MS = 600;

/** Run `then` once `screen` has slid where it was sent. */
function afterSlide(screen: HTMLElement, then: () => void): void {
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    screen.removeEventListener("transitionend", ended);
    window.clearTimeout(timer);
    then();
  };
  const ended = (event: TransitionEvent) => {
    if (event.target === screen && event.propertyName === "transform") finish();
  };
  screen.addEventListener("transitionend", ended);
  const timer = window.setTimeout(finish, SLIDE_MAX_MS);
}

/** Where a finger can't start a swipe: what it lands on takes fingers of its own. */
const TYPED_IN = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Watch for an iPhone's swipe in from the left edge (core/edgeSwipe.ts) and
 * go back with it, as Android's Back does. Answers how to stop.
 */
function watchSwipes(): () => void {
  // What was newest when the finger landed, before anything the press
  // itself closes (a person's card closes on a press outside it): that's
  // what Back goes back from, as with Android's.
  let landed: Entry | null = null;
  // What this swipe goes back from, and what follows the finger.
  let from: Entry | null = null;
  let screen: HTMLElement | null = null;
  // A slide finishing: no new swipe until it's done.
  let sliding = false;
  const swipe = startEdgeSwipe(() => window.innerWidth, {
    take: () => {
      if (from === null || !handlers.includes(from)) return false;
      screen = from.swipe.slide?.() ?? null;
      if (screen) {
        screen.style.setProperty("--swipe-x", "0px");
        screen.dataset.swipe = "follow";
      }
      return true;
    },
    follow: (by) => screen?.style.setProperty("--swipe-x", `${by}px`),
    done: (back) => {
      const was = from;
      const moved = screen;
      from = null;
      screen = null;
      const goBack = () => {
        if (back && was && handlers.includes(was)) flushSync(() => was.back());
      };
      if (moved === null) {
        goBack();
        return;
      }
      sliding = true;
      moved.dataset.swipe = back ? "off" : "home";
      moved.style.setProperty("--swipe-x", back ? `${moved.offsetWidth}px` : "0px");
      afterSlide(moved, () => {
        // Gone before it's put back: the screen that was under it is drawn
        // in the same frame, with nothing between.
        goBack();
        delete moved.dataset.swipe;
        moved.style.removeProperty("--swipe-x");
        sliding = false;
      });
    },
  });

  const landing = (event: PointerEvent) => {
    if (event.pointerType === "touch" && event.isPrimary) landed = handlers.at(-1) ?? null;
  };
  const start = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    const entry = landed ?? handlers.at(-1) ?? null;
    landed = null;
    // Any finger already down is done with: one, or a second's pinch.
    swipe.stop();
    const typedIn = event.target instanceof Element && event.target.closest(TYPED_IN) !== null;
    if (!touch || sliding || entry === null || entry.swipe.now?.() === false || typedIn) return;
    from = entry;
    swipe.down(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.touches.length);
  };
  const moved = (event: TouchEvent) => {
    for (const touch of event.changedTouches) {
      // Taken, the finger is the swipe's: the page under it doesn't scroll.
      if (swipe.move(touch.identifier, touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
    }
  };
  // What a finger landed on is forgotten as it lifts, so an engine that sends
  // the next finger's touch before its pointer can't be handed an old one.
  const lifted = (event: TouchEvent) => {
    landed = null;
    for (const touch of event.changedTouches) swipe.up(touch.identifier, event.timeStamp);
  };
  const taken = (event: TouchEvent) => {
    landed = null;
    for (const touch of event.changedTouches) swipe.cancel(touch.identifier);
  };
  const quiet = { capture: true, passive: true };
  // Not passive: a swipe stops the page scrolling with it.
  const holding = { capture: true, passive: false };
  window.addEventListener("pointerdown", landing, quiet);
  document.addEventListener("touchstart", start, quiet);
  document.addEventListener("touchmove", moved, holding);
  document.addEventListener("touchend", lifted, quiet);
  document.addEventListener("touchcancel", taken, quiet);
  return () => {
    window.removeEventListener("pointerdown", landing, quiet);
    document.removeEventListener("touchstart", start, quiet);
    document.removeEventListener("touchmove", moved, holding);
    document.removeEventListener("touchend", lifted, quiet);
    document.removeEventListener("touchcancel", taken, quiet);
    swipe.stop();
  };
}

/**
 * Android's back button and gesture, while there's somewhere in Linger to go
 * back to (SPEC §4.15): a picture open, a conversation over the list, a
 * Settings section. The newest of them answers. With none, nobody listens,
 * and Tauri hands Back to Android, which leaves the app, the way it should
 * from the list itself. Before this, Back in a conversation left the app
 * rather than going back to the list.
 *
 * An iPhone has no Back of its own, so there the same newest one answers a
 * finger swiped in from the left edge instead (#697), and `swipe` says how
 * it moves meanwhile. Only there: Android's own gesture is already Back, and
 * a second from the page would go back twice.
 */
export function useBackButton(active: boolean, back: () => void, swipe: Swipe = {}): void {
  const latest = useRef(back);
  latest.current = back;
  const latestSwipe = useRef(swipe);
  latestSwipe.current = swipe;
  useEffect(() => {
    if (!active || !isTauri() || !onPhone()) return;
    const entry: Entry = {
      back: () => latest.current(),
      swipe: {
        slide: () => latestSwipe.current.slide?.() ?? null,
        now: () => latestSwipe.current.now?.() ?? true,
      },
    };
    handlers.push(entry);
    if (onIPhone()) watching ??= watchSwipes();
    else listen();
    return () => {
      const at = handlers.indexOf(entry);
      if (at >= 0) handlers.splice(at, 1);
      if (handlers.length > 0) return;
      stopListening();
      watching?.();
      watching = null;
    };
  }, [active]);
}
