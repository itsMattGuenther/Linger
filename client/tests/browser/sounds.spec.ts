import { expect, test } from "@playwright/test";
test.use({ timezoneId: "UTC" });

test("quiet defaults, category choices and master silence survive reload", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-17T12:00:00Z") });
  await page.goto("/tests/fixtures/sounds.html");
  for (const name of [
    "voice joins, leaves and moves",
    "mute and deafen controls",
    "DM messages",
    "knocks",
  ]) {
    await expect(page.getByRole("switch", { name, exact: true })).toBeChecked();
  }
  await expect(
    page.getByRole("switch", { name: "Quiet hours", exact: true }),
  ).not.toBeChecked();
  const rooms = page.getByRole("switch", {
    name: "room messages",
    exact: true,
  });
  await expect(rooms).not.toBeChecked();
  await rooms.check();
  await page
    .getByRole("switch", { name: "DM messages", exact: true })
    .uncheck();
  await page
    .getByRole("switch", { name: "Mute all notification sounds" })
    .check();
  for (const button of await page
    .getByRole("button", { name: /^preview/ })
    .all())
    await expect(button).toBeEnabled();
  await page.reload();
  await expect(rooms).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "DM messages", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Mute all notification sounds" }),
  ).toBeChecked();
});

test("quiet hours silence message and knock chimes but play still previews (#186)", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-17T03:00:00Z") });
  await page.goto("/tests/fixtures/sounds.html");
  await expect(
    page.getByRole("switch", { name: "Quiet hours", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByText(/Quiet hours are silencing/),
  ).toHaveCount(0);
  await page
    .getByRole("switch", { name: "Quiet hours", exact: true })
    .check();
  await expect(
    page.getByText("Quiet hours are silencing message and knock chimes until 08:00. Voice and mute/deafen sounds still play."),
  ).toBeVisible();
  await expect(
    page
      .locator(".sound-preference")
      .filter({ hasText: "DM messages" })
      .getByRole("button"),
  ).toBeEnabled();
  await expect(
    page
      .locator(".sound-preference")
      .filter({ hasText: "room messages" })
      .getByRole("button"),
  ).toBeEnabled();
  await page
    .getByRole("switch", { name: "Quiet hours", exact: true })
    .uncheck();
  await expect(
    page.getByText(/Quiet hours are silencing/),
  ).toHaveCount(0);
  await expect(
    page.getByText(/To silence people in voice, use deafen/),
  ).toBeVisible();
});
