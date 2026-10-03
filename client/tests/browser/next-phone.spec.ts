import { expect, type Page, test } from "@playwright/test";

// The phone app (SPEC §4.15): the same list window, opened as the phone's one
// window (`?shell=phone`, core/phone.ts), at a phone's size. Nothing on it may
// need a second window, and nothing desktop-only is offered.

test.use({ viewport: { width: 411, height: 914 } });

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

test("has no close button of its own: a phone's app is closed the phone's way", async ({ page }) => {
  await open(page, "");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toBeVisible();
  await open(page, "?shell=phone");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toHaveCount(0);
});

test("opens Settings over the list, as its sections and then one section, without asking for a window", async ({ page }) => {
  // A computer asks the shell for Settings' own window.
  await open(page, "");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => (await did(page)).some((line) => line.startsWith("next_open_settings"))).toBe(true);
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);

  await open(page, "?shell=phone");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  await expect(settings).toBeVisible();
  expect((await did(page)).some((line) => line.includes("next_open_settings"))).toBe(false);

  // The sections first, the whole width: nothing a phone doesn't have.
  const sections = settings.getByRole("navigation", { name: "Settings" });
  await expect(sections).toBeVisible();
  await expect(settings.locator(".nx-set-main")).toBeHidden();
  await expect(sections).toContainText("Profile");
  await expect(sections).toContainText("Sound");
  await expect(sections).not.toContainText("Windows");
  await expect(sections).not.toContainText("Notifications");
  await expect(sections).not.toContainText("Voice");

  // One section, the whole width, with the way back.
  await sections.getByText("Appearance").click();
  await expect(sections).toBeHidden();
  await expect(settings.locator(".nx-set-title")).toHaveText("Appearance");
  await settings.getByRole("button", { name: "Back to Settings" }).click();
  await expect(sections).toBeVisible();

  // Closing it is the list again.
  await settings.getByRole("button", { name: "Close window" }).click();
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
});
