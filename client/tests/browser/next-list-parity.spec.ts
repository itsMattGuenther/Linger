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

test("each server's name is asked for when its connection comes up or comes back, then hourly, and its address stands in when it won't say (SRV-4, #536)", async ({ page }) => {
  const opened = new Date("2026-09-25T22:52:00");
  const minutes = (count: number) => count * 60_000;
  await page.clock.install({ time: opened });
  await page.goto("/tests/fixtures/next-list-window.html?noinfo");
  await expect(page.getByRole("region", { name: "The Good Company", exact: true })).toBeVisible();
  // The clock stands still between looks, so a slow machine can't skip a tick.
  await page.clock.pauseAt(new Date(opened.getTime() + 10_000));
  // Casa da Ribeira wouldn't say: it goes by its address.
  await expect(page.getByRole("region", { name: "casa-da-ribeira.example", exact: true })).toBeVisible();
  await expect.poll(() => asked(page, HOME)).toBeGreaterThan(0);
  await expect.poll(() => asked(page, LISBON)).toBeGreaterThan(0);
  const home = await asked(page, HOME);
  const lisbon = await asked(page, LISBON);

  // An answer holds for an hour: no asking every two minutes (#536).
  await page.clock.runFor(minutes(2) + 10_000);
  expect(await asked(page, HOME)).toBe(home);
  // One that failed is tried again in two minutes, and still goes by its
  // address, not a blank.
  await expect.poll(() => asked(page, LISBON)).toBe(lisbon + 1);
  await expect(page.getByRole("region", { name: "casa-da-ribeira.example", exact: true })).toBeVisible();
  // Jumped ahead, then run a moment: the fixture answers after 10 ms, and
  // its sign-ins last 10 minutes, so the hourly ask renews one first.
  await page.clock.fastForward(minutes(55));
  await page.clock.runFor(1_000);
  expect(await asked(page, HOME)).toBe(home);
  await page.clock.fastForward(minutes(3));
  await page.clock.runFor(1_000);
  await expect.poll(() => asked(page, HOME)).toBe(home + 1);

  // The connection saying it's still there asks nothing...
  await page.evaluate((server) => window.core?.status(server, { kind: "ready", latency_ms: 31 }), HOME);
  await page.clock.runFor(1_000);
  expect(await asked(page, HOME)).toBe(home + 1);
  // ...and coming back after a drop asks again: the name may have changed meanwhile.
  await page.evaluate((server) => window.core?.status(server, { kind: "resuming" }), HOME);
  await page.evaluate((server) => window.core?.status(server, { kind: "ready", latency_ms: 20 }), HOME);
  await expect.poll(() => asked(page, HOME)).toBe(home + 2);
  // Settings saved its name or color: asked at once, not an hour later.
  await page.evaluate((server) => window.core?.ask("next:intent", { kind: "serverinfo", server }), HOME);
  await expect.poll(() => asked(page, HOME)).toBe(home + 3);
});
