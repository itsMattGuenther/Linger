import { expect, test } from "@playwright/test";

test("the desktop welcome preview keeps real storage failures visible", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/welcome.html");
  await expect(
    page.getByRole("heading", { name: "Linger", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".auth-keyring")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Scale" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await page.getByText("Setting up a new server?", { exact: true }).click();
  await expect(
    page.getByText(
      "Paste the full setup link from your server logs, including its token.",
    ),
  ).toBeVisible();
  await page.goto("/tests/fixtures/welcome.html?unavailable");
  await expect(page.getByRole("status")).toContainText(
    "Your computer's secure storage is unavailable.",
  );
  await expect(page.getByRole("status")).toContainText(
    "You'll have to sign in again next time.",
  );
});

test("the browser fallback remains honest about unsaved sign-ins", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".auth-keyring")).toContainText(
    "Browser preview: sign-ins aren't saved here.",
  );
});

test("the live guide uses working keyboard controls and shared action styles", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/styleguide.html");
  const warmth = page.getByRole("switch", {
    name: "Evening warmth",
    exact: true,
  });
  await expect(warmth).toBeChecked();
  await warmth.focus();
  await page.keyboard.press("Space");
  await expect(warmth).not.toBeChecked();
  const mute = page.getByRole("button", { name: "Mute", exact: true });
  await mute.click();
  await expect(mute).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Muted", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Join Voice", exact: true }),
  ).toHaveClass(/ui-primary/);
  await expect(
    page.getByRole("button", { name: "Add a server", exact: true }),
  ).not.toHaveClass(/ui-primary/);
  const primary = await page
    .getByRole("button", { name: "Join Voice", exact: true })
    .boundingBox();
  const secondary = await page
    .getByRole("button", { name: "Add a server", exact: true })
    .boundingBox();
  expect(primary?.height).toBeGreaterThanOrEqual(40);
  expect(secondary?.height).toBeGreaterThanOrEqual(36);
  await page
    .getByRole("combobox", { name: "Preview theme" })
    .selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("Appearance switches and theme choices survive a restart", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const openAppearance = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
  };
  await openAppearance();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page
    .getByRole("switch", { name: "Evening warmth", exact: true })
    .uncheck();
  await page
    .getByRole("switch", {
      name: "Use plain names and message fonts",
      exact: true,
    })
    .check();
  await page.reload();
  await openAppearance();
  await expect(
    page.getByRole("button", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("switch", { name: "Evening warmth", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", {
      name: "Use plain names and message fonts",
      exact: true,
    }),
  ).toBeChecked();
});
