import { expect, type Page, test } from "@playwright/test";

// The list window's items in docs/design/parity.md that had no test in the
// new client, on the real list window (tests/fixtures/next-list-window.tsx).

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const LISBON = "https://casa-da-ribeira.example";

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const asked = async (page: Page, server: string) => (await did(page)).filter((line) => line === `GET ${server}/server`).length;

test("each server's name is asked for again every two minutes, and its address stands in when it won't say (SRV-4)", async ({ page }) => {
  const opened = new Date("2026-09-25T22:52:00");
  await page.clock.install({ time: opened });
  await page.goto("/tests/fixtures/next-list-window.html?noinfo");
  await expect(page.getByRole("region", { name: "The Good Company", exact: true })).toBeVisible();
  // The clock stands still between looks, so a slow machine can't skip a tick.
  await page.clock.pauseAt(new Date(opened.getTime() + 10_000));
  // Casa da Ribeira wouldn't say: it goes by its address.
  await expect(page.getByRole("region", { name: "casa-da-ribeira.example", exact: true })).toBeVisible();
  await expect.poll(() => asked(page, LISBON)).toBeGreaterThan(0);
  const home = await asked(page, HOME);
  const lisbon = await asked(page, LISBON);

  await page.clock.runFor(100_000);
  expect(await asked(page, HOME)).toBe(home);
  await page.clock.runFor(20_000);
  await expect.poll(() => asked(page, HOME)).toBe(home + 1);
  await expect.poll(() => asked(page, LISBON)).toBe(lisbon + 1);
  // Still no name from Lisbon, and still its address, not a blank.
  await expect(page.getByRole("region", { name: "casa-da-ribeira.example", exact: true })).toBeVisible();
});
