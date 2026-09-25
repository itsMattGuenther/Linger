import { expect, test, type Locator, type Page } from "@playwright/test";

// The console fixture's `?history` room: 10,000 messages, `message-00000` to
// `message-09999`, paged a hundred at a time like the real server.
const heldIds = (page: Page, room = "general") =>
  page.evaluate(
    (room) => (window as unknown as { heldIds: (room: string) => string[] | null }).heldIds(room),
    room,
  );

function expectContiguous(ids: string[]): void {
  const numbers = ids.map((one) => Number(one.slice("message-".length)));
  for (let at = 1; at < numbers.length; at += 1) expect(numbers[at]).toBe((numbers[at - 1] ?? 0) + 1);
}

/** Scroll to the top until the room holds at least `count` messages. */
async function readBackTo(page: Page, scroller: Locator, count: number): Promise<void> {
  await expect.poll(async () => {
    // Two writes, so there is always a scroll event even if already at 0.
    await scroller.evaluate((element) => { element.scrollTop = 1; element.scrollTop = 0; });
    return (await heldIds(page))?.length ?? 0;
  }, { timeout: 10_000, intervals: [100] }).toBeGreaterThanOrEqual(count);
}

/** The first message whose top is inside the view, and where it sits. */
async function topMessage(scroller: Locator): Promise<{ text: string; top: number; viewTop: number }> {
  return scroller.evaluate((element) => {
    const view = element.getBoundingClientRect();
    for (const message of element.querySelectorAll<HTMLElement>(".msg")) {
      const box = message.getBoundingClientRect();
      // Measured from the top of the scrolling area, so a header that grows a
      // button is not mistaken for the list moving.
      if (box.top >= view.top) return { text: message.querySelector(".msg-body")?.textContent ?? "", top: box.top - view.top, viewTop: view.top };
    }
    throw new Error("no message on screen");
  });
}

test("reading far back lets go of distant history without moving the view, and reads back without a gap (#173)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/fixtures/console.html?history");
  await expect(page.locator(".msg").first()).toBeVisible();
  const scroller = page.locator(".stream-body");
  const newest = page.getByRole("button", { name: "back to the newest", exact: true });
  await expect.poll(async () => (await heldIds(page))?.length).toBe(100);

  // Read back eleven pages, one scroll to the top at a time.
  for (let pages = 2; pages <= 11; pages += 1) await readBackTo(page, scroller, pages * 100);
  // Stop scrolling a little way below the top, so the next page does not load.
  await scroller.evaluate((element) => { element.scrollTop = 1500; });
  await page.waitForTimeout(100);
  const before = await topMessage(scroller);

  // Once scrolling stops, the far newer end is let go of.
  await expect.poll(async () => (await heldIds(page))?.length ?? 0, { timeout: 5_000 }).toBeLessThan(800);
  const trimmed = (await heldIds(page)) ?? [];
  expectContiguous(trimmed);
  expect(trimmed.at(-1)).not.toBe("message-09999");
  // And what you were reading did not move.
  const after = await topMessage(scroller);
  expect(after.text).toBe(before.text);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  // Nor did the header grow a line for "back to the newest" and push it down.
  expect(Math.abs(after.viewTop - before.viewTop)).toBeLessThanOrEqual(0.5);
  // The room is behind its newest message now, and says so the usual way.
  await expect(newest).toBeVisible();

  // Reading down to the bottom brings everything back, in order, no gap.
  await expect.poll(async () => {
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    return newest.isVisible();
  }, { timeout: 60_000, intervals: [100] }).toBe(false);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(1000);
  const whole = (await heldIds(page)) ?? [];
  expect(whole.at(-1)).toBe("message-09999");
  expectContiguous(whole);
  await expect(page.locator(".msg-body").last()).toContainText("History sample 9999.");
  // Back at the bottom, the older end is let go of in turn.
  expect(whole.length).toBeLessThan(800);
});

test("a room you leave keeps only its newest page (#173)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/fixtures/console.html?history");
  await expect(page.locator(".msg").first()).toBeVisible();
  const scroller = page.locator(".stream-body");
  for (let pages = 2; pages <= 4; pages += 1) await readBackTo(page, scroller, pages * 100);

  await page.locator(".rail").getByRole("button", { name: /listening-room/ }).click();
  await expect.poll(async () => (await heldIds(page))?.length).toBe(100);
  const kept = (await heldIds(page)) ?? [];
  expect(kept.at(-1)).toBe("message-09999");
  expectContiguous(kept);

  // Walking back in opens at the newest message, as it always did.
  await page.locator(".rail").getByRole("button", { name: /general/ }).click();
  await expect(page.locator(".msg-body").last()).toContainText("History sample 9999.");
});
