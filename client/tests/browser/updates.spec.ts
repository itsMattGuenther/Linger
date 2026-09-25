import { expect, test } from "@playwright/test";

test("a waiting update links to its release notes instead of reprinting them (#174)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?update");
  await page.getByRole("button", { name: "update ready", exact: true }).click();

  await expect(page.getByText("Version 0.3.5 is ready to install.")).toBeVisible();
  await expect(page.getByText("You are on version 0.3.4.")).toBeVisible();
  // The updater hands over the whole release body; none of it is shown.
  await expect(page.getByText("# Linger 0.3.5", { exact: false })).toHaveCount(0);
  await expect(page.getByText("A very long list of changes", { exact: false })).toHaveCount(0);
  await expect(page.locator(".settings-notes")).toHaveCount(0);

  await page.getByRole("button", { name: "what's new", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.openedUrl))
    .toBe("https://github.com/itsMattGuenther/Linger/releases/tag/v0.3.5");
  await expect(page.getByRole("button", { name: "install and restart", exact: true })).toBeVisible();
});

test("with no update waiting there is no release link", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Account & App", exact: true }).click();
  await expect(page.getByText("This is the newest version.")).toBeVisible();
  await expect(page.getByRole("button", { name: "what's new", exact: true })).toHaveCount(0);
});
