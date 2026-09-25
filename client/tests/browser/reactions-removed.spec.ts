import { expect, test } from "@playwright/test";

// Reactions were taken out of the app as a trial (#168). The server still
// stores and sends them, so the fixture's message-00005 carries a stored heart
// and `fixture-reaction` delivers a live `reaction.update`. Neither may draw.
test("messages show no reactions and offer no way to add one (#168)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html");
  const messages = page.locator(".msg");
  await expect(messages.first()).toBeVisible();
  await expect(page.locator(".reactions, .reaction")).toHaveCount(0);

  await page.evaluate(() => document.dispatchEvent(new Event("fixture-reaction")));
  // A live reaction from somebody on an older client lands and draws nothing.
  await expect(page.locator(".reactions, .reaction")).toHaveCount(0);

  const message = messages.last();
  await message.hover();
  await message.getByRole("button", { name: /^Actions for/ }).click();
  const menu = page.getByRole("menu", { name: /^Actions for/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /react/i })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /^reply to/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("emoji still go into what you say (#168)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html");
  const box = page.locator(".composer-input");
  await box.fill("nice ");
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
  const picker = page.getByRole("dialog").or(page.getByRole("menu")).last();
  await expect(picker).toBeVisible();
  await picker.getByRole("button").or(picker.getByRole("menuitem")).first().click();
  await expect(box).not.toHaveValue("nice ");
  await expect(box).toHaveValue(/^nice \p{Extended_Pictographic}/u);
});
