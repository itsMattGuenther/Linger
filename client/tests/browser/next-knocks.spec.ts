import { expect, test } from "@playwright/test";

// Somebody knocking on your door (SPEC §4.9, parity KNOCK-2), on the list
// window: tests/fixtures/next-knocks.tsx.

test.use({ viewport: { width: 340, height: 820 } });

// The page's clock stands still between steps: left running, a slow machine
// spends real seconds between two checks and a card goes before it's looked at.
const OPENED = new Date("2026-09-25T20:00:00");

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: OPENED });
  await page.goto("/tests/fixtures/next-knocks.html");
  await page.evaluate(() => document.fonts.ready);
  await page.clock.pauseAt(new Date(OPENED.getTime() + 600_000));
});

const cards = (page: import("@playwright/test").Page) => page.locator("[data-screen='knocks'] [data-kit='Notice']");

test("says who knocked, politely, with nothing to press and without taking focus", async ({ page }) => {
  const room = page.getByRole("button", { name: "#general, 3 people in it, voice on" });
  await room.focus();
  await page.evaluate(() => window.knocks?.arrive("u-jules"));
  await expect(cards(page)).toHaveText("Jules knocked. Just saying hi.");
  await expect(cards(page)).toHaveAttribute("role", "status");
  await expect(cards(page).locator("button, a, input, [tabindex]")).toHaveCount(0);
  await expect(room).toBeFocused();
  // Their name is drawn as they chose it.
  await expect(cards(page).locator("[data-kit='Name']")).toHaveCount(1);
});

test("goes by itself eight seconds after it arrived, and nothing is left", async ({ page }) => {
  await page.evaluate(() => window.knocks?.arrive("u-jules"));
  await page.clock.fastForward(4_000);
  await page.evaluate(() => window.knocks?.arrive("u-eli"));
  await expect(cards(page)).toHaveCount(2);
  await page.clock.fastForward(3_900);
  await expect(cards(page)).toHaveCount(2);
  await page.clock.fastForward(200);
  await expect(cards(page)).toHaveText(["Eli knocked. Just saying hi."]);
  await page.clock.fastForward(4_000);
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-gone", "knock-1,knock-2");
  await expect(page.locator("[data-screen='knocks']")).toHaveCount(0);
});

test("a card drawn late still goes on time: its eight seconds started when the knock arrived", async ({ page }) => {
  await page.evaluate(() => window.knocks?.arrive("u-dave", undefined, 6_000));
  await expect(cards(page)).toHaveCount(1);
  await page.clock.fastForward(2_100);
  await expect(cards(page)).toHaveCount(0);
});

test("names the server only when you're on more than one, and someone unknown is somebody", async ({ page }) => {
  await page.evaluate(() => window.knocks?.arrive("u-jules", "Raid Night"));
  await page.evaluate(() => window.knocks?.arrive(null));
  await expect(cards(page)).toHaveText(["Jules knocked. Just saying hi.Raid Night", "Somebody knocked. Just saying hi."]);
});

test("sits just above the voice bar, never over it, and clicks go straight through it", async ({ page }) => {
  await page.goto("/tests/fixtures/next-knocks.html?voice");
  await page.evaluate(() => window.knocks?.arrive("u-callie"));
  await page.evaluate(() => window.knocks?.arrive("u-dave"));
  const band = await page.locator("[data-screen='knocks']").boundingBox();
  const bar = await page.getByRole("region", { name: /In voice/ }).boundingBox();
  const title = await page.locator(".k-titlebar").boundingBox();
  expect(band && bar && title).toBeTruthy();
  if (!band || !bar || !title) return;
  // Its bottom meets the voice bar's top (the bar's own margin apart at most).
  expect(band.y + band.height).toBeLessThanOrEqual(bar.y);
  expect(bar.y - (band.y + band.height)).toBeLessThanOrEqual(8);
  expect(band.y).toBeGreaterThan(title.y + title.height);
  expect(band.x).toBeGreaterThanOrEqual(0);
  expect(band.x + band.width).toBeLessThanOrEqual(340);
  // Whatever is under it still works.
  const card = await cards(page).first().boundingBox();
  if (!card) return;
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-screen]")?.getAttribute("data-screen"), {
    x: card.x + card.width / 2,
    y: card.y + card.height / 2,
  });
  expect(under).toBe("list");
});
