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
 * A finger flicked from `from`, `by` pixels down (up when negative), and let
 * go fast enough to leave the page gliding on, as a thumb does (#698). Each
 * touch is stamped a frame (16 ms) after the last, whenever it gets there:
 * Chromium judges a finger's speed by those stamps, and the protocol's own
 * pace is far too slow to glide. Chromium only, like `finger`.
 */
export async function flick(page: Page, from: { x: number; y: number }, by: number) {
  const cdp = await page.context().newCDPSession(page);
  let at = Date.now() / 1000;
  const send = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [], timestamp: (at += 0.016) });
  await send("touchStart", from);
  for (let step = 1; step <= 4; step += 1) await send("touchMove", { x: from.x, y: from.y + (by * step) / 4 });
  await send("touchEnd");
  await cdp.detach();
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
 * Make the page an iPhone's as far as a tap goes (#704). WebKit on an iPhone
 * moves the hover to where a finger tapped before it sends the tap's click,
 * and when that hover brings something you could press into sight that
 * wasn't (shown from `display: none`, `visibility: hidden` or `opacity: 0`),
 * it takes the tap as a hover only: no click, until a second tap. No engine
 * a test can run does that, so this does it in the page: it notes what could
 * be pressed and was in sight as a finger lands, and swallows the tap's click
 * if anything that could be pressed has come into sight by then. The click
 * comes after the tap's focus too, so this is stricter than an iPhone.
 * `hoverOnly` says what came into sight, each time it happened.
 */
export async function iPhoneTaps(page: Page) {
  await page.evaluate(() => {
    const PRESSABLE = "button, a[href], input, select, textarea, [role='button'], [role='menuitem']";
    const inSight = (element: Element) => {
      if (element.getClientRects().length === 0 || getComputedStyle(element).visibility !== "visible") return false;
      for (let up: Element | null = element; up; up = up.parentElement) if (Number(getComputedStyle(up).opacity) === 0) return false;
      return true;
    };
    const pressable = () => [...document.querySelectorAll(PRESSABLE)].filter(inSight);
    const said: string[] = [];
    Object.assign(window, { hoverOnly: said });
    let landed: Set<Element> | null = null;
    document.addEventListener("touchstart", () => (landed = new Set(pressable())), { capture: true });
    window.addEventListener(
      "click",
      (event) => {
        const before = landed;
        landed = null;
        if (before === null) return;
        const appeared = pressable().filter((element) => !before.has(element));
        if (appeared.length === 0) return;
        said.push(appeared.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName).join(", "));
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
  });
}

/** What `iPhoneTaps` took as a hover only: what each such tap brought into sight. */
export async function hoverOnly(page: Page): Promise<string[]> {
  return page.evaluate(() => ("hoverOnly" in window && Array.isArray(window.hoverOnly) ? window.hoverOnly.map(String) : []));
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
