import { expect, type Page, test } from "@playwright/test";
import { flick } from "./finger";

// A thumb's swipe in a long conversation on the phone glides on and slows to
// a stop without a skip, toward older messages and into pages of them loading
// as it goes (#698). A row's height is a guess until it's drawn, and each one
// drawn above the reader moves what they're reading by the difference, which
// the virtualizer makes up for by moving the scroll position. Drawn a frame
// before the rows moved (Android), that was a jump back and forward again; on
// an iPhone, where the virtualizer can't move the scroll position mid-glide,
// it was a lurch per row and every correction at once when the glide stopped,
// and a page arriving mid-glide threw the view a page further each time.
//
// Only Chromium can make a real glide in a test (finger.ts), and it's
// Android's engine. The virtualizer takes its iPhone path by the user agent,
// so the iPhone's runs below are Chromium's glide with the page as an
// iPhone's: everything the page does is the iPhone's, but WebKit's own
// scrolling (a glide that a moved scroll position stops dead) isn't, and
// Playwright's WebKit makes no glides. The tests after the glides need no
// glide and run in both engines.

/** What an iPhone's web view says it is: the virtualizer and `core/phone.ts` both go by it. */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
/** Asking for the page before the oldest message held (`?many`'s are `l0000001`…). */
const OLDER = "history r-general?limit=100&before=";

interface Frame {
  /** How far the words in the middle of the screen moved down it since the frame before, as painted. */
  moved: number | null;
  /** How far the conversation was scrolled, as painted. */
  top: number;
  /** How far the page itself moved the scroll position since the frame before, writing it. */
  byPage: number;
}

declare global {
  interface Window {
    glide?: { frames: Frame[] };
  }
}

test.use({ viewport: { width: 411, height: 914 } });

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** #general on the phone, 3,000 messages long, landed on the newest: it holds its newest page of 100. */
async function longRoom(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one&many=3000&shell=phone");
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  // Landed: until then it re-aims at the newest every frame, and would pull
  // a test's scrolling back down.
  await expect(page.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
}

const log = (page: Page) => page.getByRole("log");
const scrollTop = (page: Page) => log(page).evaluate((element) => element.scrollTop);
const scrollHeight = (page: Page) => log(page).evaluate((element) => element.scrollHeight);
const asked = async (page: Page) => (await did(page)).filter((line) => line.startsWith(OLDER)).length;

/** Scrolled up to `top`, by the page rather than a finger, and left still. */
async function scrolledTo(page: Page, top: number) {
  await log(page).evaluate((element, to) => {
    element.scrollTop = to;
  }, top);
  await settled(page);
}

/** Nothing has moved the conversation for a while: any page asked for is in, and measured. */
async function settled(page: Page) {
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await scrollTop(page);
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [300] },
    )
    .toBe(true);
}

/**
 * Watch the conversation frame by frame, as it's painted: how far the words in
 * the middle of the screen moved, how far it was scrolled, and how far the
 * page moved the scroll position itself. Read after the virtualizer's own
 * ResizeObserver, where it measures rows and corrects the scroll, so a frame
 * painted between a correction and the rows moving is seen as it was painted.
 */
async function watch(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[role='log']");
    if (!scroller) throw new Error("no conversation");
    const glide = { frames: [] as Frame[] };
    window.glide = glide;
    // Every scroll position the page writes, by how far it really moved.
    let byPage = 0;
    const position = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const read = () => Number(position?.get?.call(scroller));
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: read,
      set(value: number) {
        const before = read();
        position?.set?.call(scroller, value);
        byPage += read() - before;
      },
    });
    const scrollTo = scroller.scrollTo.bind(scroller) as (...args: unknown[]) => void;
    scroller.scrollTo = ((...args: unknown[]) => {
      const before = read();
      scrollTo(...args);
      byPage += read() - before;
    }) as typeof scroller.scrollTo;
    const middle = () => {
      const box = scroller.getBoundingClientRect();
      const row = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest<HTMLElement>(".nx-conv-row");
      return row?.dataset.key ? { key: row.dataset.key, top: row.getBoundingClientRect().top } : null;
    };
    let last = middle();
    // Resized every frame, so its observer runs every frame, after the
    // virtualizer's (made earlier, so called earlier) and before the paint.
    const beat = document.createElement("div");
    beat.style.cssText = "position: fixed; top: 0; left: 0; width: 1px; height: 1px; pointer-events: none";
    document.body.append(beat);
    new ResizeObserver(() => {
      const same = last ? scroller.querySelector(`[data-key="${CSS.escape(last.key)}"]`) : null;
      glide.frames.push({ moved: last && same ? same.getBoundingClientRect().top - last.top : null, top: read(), byPage });
      byPage = 0;
      last = middle();
    }).observe(beat);
    let tall = false;
    const frame = () => {
      tall = !tall;
      beat.style.height = tall ? "2px" : "1px";
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Every frame in which something but the glide moved the words on the
 * screen. Scrolling alone moves them exactly as far as the scroll position
 * moved, the other way, in every frame as painted, however late the page
 * draws it. What #698 was is anything else: the page correcting the scroll
 * for a row above a frame before the rows moved (Android), rows above moving
 * with the correction held back (an iPhone), the held corrections written
 * all at once when the glide stopped, a page going in above with nothing
 * correcting it, or the virtualizer pulling the view back to a row it had
 * been sent to. Also how far it glided.
 */
function skips(frames: Frame[]): { skipped: string[]; glided: number } {
  const skipped: string[] = [];
  let glided = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const frame = frames[index];
    const before = frames[index - 1];
    if (!frame || !before) continue;
    const scrolled = frame.top - before.top - frame.byPage;
    glided -= scrolled;
    if (frame.moved !== null && Math.abs(frame.moved + scrolled) > 1) {
      skipped.push(`frame ${index}: the words moved ${Math.round(frame.moved)}px while the conversation scrolled ${Math.round(-scrolled)}px`);
    }
  }
  return { skipped, glided };
}

/** A thumb's fast swipe down the middle of the conversation, toward older messages, and what the glide did. */
async function glideOlder(page: Page) {
  await watch(page);
  await flick(page, { x: 200, y: 300 }, 300);
  // The glide, then whatever waited for it to stop.
  await page.waitForTimeout(3500);
  const glide = await page.evaluate(() => window.glide);
  if (!glide) throw new Error("not watching");
  return skips(glide.frames);
}

for (const [engine, userAgent] of [
  ["Android", ANDROID],
  ["an iPhone", IPHONE],
] as const) {
  test.describe(`on ${engine}, a glide in a long conversation slows to a stop without a skip (#698)`, () => {
    test.use({ isMobile: true, hasTouch: true, userAgent });
    test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test make a glide");

    test("toward older messages, into a page of them loading as it goes", async ({ page }) => {
      await longRoom(page);
      // Short of where the next page is asked for (1,200px from the top of
      // what's held): the glide asks for it on its way, and runs on into it,
      // or on an iPhone, to the top of what's held, where it waits.
      await scrolledTo(page, 1700);
      expect(await asked(page)).toBe(0);
      const tall = await scrollHeight(page);
      const { skipped, glided } = await glideOlder(page);
      expect(glided).toBeGreaterThan(1000);
      expect(skipped).toEqual([]);
      // The page went in, and only the one: nothing above jumped the view to
      // the top of what's held, asking for the next.
      await expect.poll(() => scrollHeight(page)).toBeGreaterThan(tall + 2000);
      expect(await asked(page)).toBe(1);
    });

    test("toward older messages, into a page of them that loaded before the swipe", async ({ page }) => {
      await longRoom(page);
      await scrolledTo(page, 1100);
      await expect.poll(() => asked(page)).toBe(1);
      await settled(page);
      expect(await scrollTop(page)).toBeGreaterThan(3000);
      const { skipped, glided } = await glideOlder(page);
      expect(glided).toBeGreaterThan(1000);
      expect(skipped).toEqual([]);
    });
  });
}

// What the glides rest on, in both engines, with the page scrolling the
// conversation rather than a finger.

test("older history that has loaded is measured before anybody scrolls up to it, so going up through it moves nothing (#698)", async ({ page }) => {
  await longRoom(page);
  await scrolledTo(page, 1100);
  await expect.poll(() => asked(page)).toBe(1);
  await settled(page);
  const tall = await scrollHeight(page);
  const heights: number[] = [];
  // Up through the page that came in, and not as far as asking for the next.
  for (let top = await scrollTop(page); top > 1500; top -= 250) {
    await log(page).evaluate((element, to) => {
      element.scrollTop = to;
    }, top);
    await page.waitForTimeout(60);
    heights.push(await scrollHeight(page));
  }
  expect(heights.length).toBeGreaterThan(5);
  // Every row came into view at the height it already had.
  expect(heights.filter((height) => height !== tall)).toEqual([]);
  expect(await asked(page)).toBe(1);
});

/** The message in the middle of the screen, where it is, and how far the conversation was scrolled then. */
interface Reading {
  id: string;
  top: number;
  at: number;
}

/**
 * Older history held back until the test lets it in (`window.letOlderIn`),
 * so a test can see where the reader is before it goes in.
 */
async function holdOlderPages(page: Page) {
  await page.evaluate(() => {
    const inner = window.fetch;
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    (window as unknown as { letOlderIn: () => void }).letOlderIn = () => open();
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("before=")) await gate;
      return inner(input, init);
    };
  });
}

/**
 * When `when` first finds what it's looking for in the conversation, as the
 * page that drew it finishes: somebody takes hold of it (if `hold`) and it's
 * scrolled up to `to`. Then the message in the middle of the screen, once
 * one is drawn there, and where it is, as `window.reading`.
 */
async function scrollAwayWhen(page: Page, when: string, to: number, hold: boolean) {
  await page.evaluate(
    ({ when, to, hold }) => {
      const observer = new MutationObserver(() => {
        const scroller = document.querySelector<HTMLElement>("[role='log']");
        if (!scroller?.matches(when) && !scroller?.querySelector(when)) return;
        observer.disconnect();
        if (hold) scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        scroller.scrollTop = to;
        const look = () => {
          const box = scroller.getBoundingClientRect();
          const row = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".nx-conv-row");
          const id = row?.querySelector<HTMLElement>("[data-message]")?.dataset.message;
          if (row && id) (window as unknown as { reading: Reading }).reading = { id, top: row.getBoundingClientRect().top, at: scroller.scrollTop };
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    },
    { when, to, hold },
  );
}

/**
 * The conversation stayed where it was scrolled to (`to`), and the message
 * in the middle of the screen there is still exactly where it was once older
 * history has gone in above it.
 */
async function stillReading(page: Page, to: number) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { reading?: unknown }).reading !== undefined)).toBe(true);
  await settled(page);
  const reading = await page.evaluate(() => (window as unknown as { reading: Reading }).reading);
  expect(reading.at).toBe(to);
  const tall = await scrollHeight(page);
  await page.evaluate(() => (window as unknown as { letOlderIn: () => void }).letOlderIn());
  await expect.poll(() => scrollHeight(page)).toBeGreaterThan(tall + 2000);
  await settled(page);
  const row = page.locator(".nx-conv-row", { has: page.locator(`[data-message="${reading.id}"]`) });
  await expect(row).toHaveCount(1);
  expect(Math.abs((await row.evaluate((element) => element.getBoundingClientRect().top)) - reading.top)).toBeLessThanOrEqual(1);
}

// The virtualizer keeps aiming at a row it was sent to for seconds after,
// whatever the reader does, and when that row moved it pulled the view to it:
// the landing's last row, once a page went in above, was in the middle of
// that page (#698). These scroll away at the moment that left it aiming.

test("taken hold of while it lands and scrolled up the moment it has, the conversation stays where it was put when older history goes in (#698)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list-window.html?one&many=3000&shell=phone");
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => (await did(page)).some((line) => line.startsWith("ready "))).toBe(true);
  await holdOlderPages(page);
  // A thumb on it as soon as there's anything to hold, while it's landing.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector("[role='log'] .nx-conv-row");
      if (!row) return;
      observer.disconnect();
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    observer.observe(document.body, { subtree: true, childList: true });
  });
  await scrollAwayWhen(page, "[role='log']:not([aria-busy]) .nx-conv-row", 1100, false);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await stillReading(page, 1100);
});

test("taken hold of just as it follows a new message down, the conversation stays where it was put when older history goes in (#698)", async ({ page }) => {
  await longRoom(page);
  await holdOlderPages(page);
  await scrollAwayWhen(page, "[data-message='m900300']", 1100, true);
  await page.evaluate(() => {
    const d = { id: "m900300", room_id: "r-general", author_id: "u-eli", body: "anyone still up?", reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: Date.now() };
    window.core?.frame("https://good-company.example", { op: "message.create", d } as never);
  });
  await stillReading(page, 1100);
});

test.describe("on an iPhone", () => {
  test.use({ userAgent: IPHONE });

  test("older history that arrives while the conversation moves waits until it's still, then goes in without moving what you're reading (#698)", async ({ page }) => {
    await longRoom(page);
    await holdOlderPages(page);
    await scrolledTo(page, 1600);
    const tall = await scrollHeight(page);
    // Moving up past where the next page is asked for, a little at a time,
    // so the conversation never stops, and the page let in on the way: it
    // arrives while the conversation moves.
    const moving = await log(page).evaluate(async (element) => {
      const heights: number[] = [];
      for (let step = 0; step < 25; step += 1) {
        element.scrollTop -= 30;
        if (step === 16) (window as unknown as { letOlderIn: () => void }).letOlderIn();
        await new Promise((resolve) => setTimeout(resolve, 30));
        heights.push(element.scrollHeight);
      }
      const box = element.getBoundingClientRect();
      const row = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest<HTMLElement>(".nx-conv-row");
      return { heights, key: row?.dataset.key ?? "", top: row?.getBoundingClientRect().top ?? 0 };
    });
    expect(await asked(page)).toBe(1);
    expect(moving.heights.filter((height) => height !== tall)).toEqual([]);
    expect(moving.key).not.toBe("");
    // Still now: the page goes in, and the words in the middle of the screen
    // stay where they are.
    await expect.poll(() => scrollHeight(page)).toBeGreaterThan(tall + 2000);
    await settled(page);
    const row = page.locator(`[data-key="${moving.key}"]`);
    await expect(row).toHaveCount(1);
    expect(Math.abs((await row.evaluate((element) => element.getBoundingClientRect().top)) - moving.top)).toBeLessThanOrEqual(1);
    expect(await asked(page)).toBe(1);
  });
});
