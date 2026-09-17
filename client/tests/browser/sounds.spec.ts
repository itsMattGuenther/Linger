import { expect, test } from "@playwright/test";
test.use({ timezoneId: "UTC" });

test("quiet defaults, category choices and master silence survive reload", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-17T12:00:00Z") });
  await page.goto("/tests/fixtures/sounds.html");
  for (const name of ["voice joins, leaves and moves", "mute and deafen controls", "DM messages", "knocks"]) {
    await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  const rooms = page.getByRole("checkbox", { name: "room messages", exact: true });
  await expect(rooms).not.toBeChecked();
  await rooms.check();
  await page.getByRole("checkbox", { name: "DM messages", exact: true }).uncheck();
  await page.getByRole("button", { name: "mute all notification sounds" }).click();
  for (const button of await page.getByRole("button", { name: /^preview/ }).all()) await expect(button).toBeDisabled();
  await page.reload();
  await expect(rooms).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "DM messages", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "mute all notification sounds" })).toHaveAttribute("aria-pressed", "true");
});

test("quiet hours gate previews without silencing the voice session", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-17T03:00:00Z") });
  await page.goto("/tests/fixtures/sounds.html");
  await expect(page.getByRole("button", { name: "preview DM messages", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "quiet hours on" }).click();
  await expect(page.getByRole("button", { name: "preview DM messages", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "preview room messages", exact: true })).toBeDisabled();
  await expect(page.getByText(/To silence people in voice, use deafen/)).toBeVisible();
});
