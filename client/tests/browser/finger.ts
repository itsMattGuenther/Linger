import type { Locator, Page } from "@playwright/test";

/**
 * A finger on the screen, held down and moved through the DevTools protocol,
 * as Chromium's own touch input; only Chromium has it, and Android's web
 * view is Chromium too. The page needs `hasTouch`. Holds are timed with it:
 * Playwright's own `tap` lifts straight away.
 */
export async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at ? [at] : [] });
  return {
    down: (at: { x: number; y: number }) => send("touchStart", at),
    move: (at: { x: number; y: number }) => send("touchMove", at),
    up: () => send("touchEnd"),
  };
}

/**
 * Two fingers put down side by side at `at` and spread apart, as a pinch to
 * zoom in is (#689). Through the same DevTools protocol as `finger`, so it's
 * Chromium's own touch input; the page needs `hasTouch` and `isMobile`, or a
 * desktop page never zooms to a pinch anyway.
 */
export async function spread(page: Page, at: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", apart: number | null) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: apart === null ? [] : [{ x: at.x - apart, y: at.y, id: 0 }, { x: at.x + apart, y: at.y, id: 1 }],
    });
  await send("touchStart", 20);
  for (let apart = 30; apart <= 120; apart += 10) {
    await send("touchMove", apart);
    await page.waitForTimeout(16);
  }
  await send("touchEnd", null);
  await cdp.detach();
}

/** Where a finger goes to press something: its middle. */
export async function middle(of: Locator): Promise<{ x: number; y: number }> {
  const box = await of.boundingBox();
  if (!box) throw new Error("not on the screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Make the page an iPhone's as far as holding goes: its web view never sends
 * the long-press (`contextmenu`) Android's does for a finger (#686), so
 * anything held there has to be timed by the page.
 */
export async function noLongPress(page: Page) {
  await page.evaluate(() =>
    window.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    ),
  );
}
