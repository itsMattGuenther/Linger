import type { Page } from "@playwright/test";

/** An animation written down as it started. */
export interface Caught {
  name: string;
  /** Its length in milliseconds, as `getComputedTiming()` gives it. */
  duration: number;
}

declare global {
  interface Window {
    caught?: { selector: string; hold: boolean; on: boolean; seen: Caught[] };
  }
}

/**
 * Catch each CSS animation on an element matching `selector` as it starts.
 * A knock's shake or rock is over in about half a second, and on a busy
 * machine a test that looked at `getAnimations()` a few round trips later
 * found it already gone (#528). Each one is written down with its length
 * (`caughtAnimations`); with `hold`, it is also paused where it started, so
 * the test can move it to a moment of its choosing and measure. Set up after
 * the page loads (a reload forgets it), before whatever starts the animation.
 */
export async function catchAnimations(page: Page, selector: string, { hold = false }: { hold?: boolean } = {}): Promise<void> {
  await page.evaluate(
    ([wanted, pause]) => {
      const caught = { selector: wanted, hold: pause, on: true, seen: [] as Caught[] };
      window.caught = caught;
      document.addEventListener(
        "animationstart",
        (event) => {
          const target = event.target;
          if (!caught.on || !(target instanceof Element) || !target.matches(caught.selector)) return;
          const running = target.getAnimations().find((one) => one instanceof CSSAnimation && one.animationName === event.animationName);
          // One short enough (reduced motion's 1 ms) is over before this
          // runs, and gone from getAnimations(): its length is the style's.
          const duration = running ? Number(running.effect?.getComputedTiming().duration) : parseFloat(getComputedStyle(target).animationDuration) * 1000;
          caught.seen.push({ name: event.animationName, duration });
          if (caught.hold) running?.pause();
        },
        true,
      );
    },
    [selector, hold] as const,
  );
}

/** What `catchAnimations` has caught so far, in the order they started. */
export async function caughtAnimations(page: Page): Promise<Caught[]> {
  return page.evaluate(() => window.caught?.seen ?? []);
}

/** Let animations that start from now on run as they would, uncaught. */
export async function stopCatching(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.caught) window.caught.on = false;
  });
}
