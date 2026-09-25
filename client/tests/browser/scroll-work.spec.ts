import { expect, test } from "@playwright/test";

// Every message row formats its full date once per render, for the tooltip on
// its time, and nothing else uses that format in the stream. Counting those
// calls counts row renders without instrumenting the app.
test("scrolling re-renders only the rows coming into view (#170)", async ({ page }) => {
  await page.addInitScript(() => {
    const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
    if (!format?.get) throw new Error("Intl.DateTimeFormat#format is not a getter here");
    const read = format.get;
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
      configurable: true,
      get(this: Intl.DateTimeFormat) {
        const bound = read.call(this) as (date?: Date | number) => string;
        if (this.resolvedOptions().dateStyle !== "full") return bound;
        return (date?: Date | number) => {
          const counted = window as unknown as { rowRenders?: number };
          counted.rowRenders = (counted.rowRenders ?? 0) + 1;
          return bound(date);
        };
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/fixtures/console.html?history");
  await expect(page.locator(".msg").first()).toBeVisible();
  // Let the walk-in scroll and row measuring finish before counting.
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(".stream-body")!;
    const drawn = () => new Set([...document.querySelectorAll<HTMLElement>(".stream-row")].map((row) => row.dataset.index));
    const before = drawn();
    const counted = window as unknown as { rowRenders?: number };
    counted.rowRenders = 0;
    const startTop = scroller.scrollTop;
    // Twenty-five small wheel-sized steps: each re-renders the stream, and
    // only a handful of rows come into view across all of them.
    for (let step = 0; step < 25; step += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      scroller.scrollTop -= 4;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const arrived = [...drawn()].filter((index) => !before.has(index)).length;
    return { renders: counted.rowRenders, arrived, moved: startTop - scroller.scrollTop, drawn: before.size };
  });

  expect(result.moved, "the stream actually scrolled").toBeGreaterThan(80);
  // Unmemoized, every drawn row re-renders on every step: 25 × ~40 rows. A
  // minute tick can re-render the drawn rows once, hence the allowance.
  expect(result.renders).toBeLessThanOrEqual(result.arrived + result.drawn + 5);
});
