import { expect, test } from "@playwright/test";
import { SCALE_OPTIONS } from "../../src/lib/interface";

for (const scale of SCALE_OPTIONS) {
  test(`composer control edges and attachment placement at ${scale}% (#88, #89)`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 600 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("linger.interface.scale", String(value)), scale);
    await page.goto("/tests/fixtures/console.html");
    const input = page.locator(".composer-input");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(input).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const measure = () => page.locator(".composer-row").evaluate((node) => {
      const field = node.querySelector(".composer-field")?.getBoundingClientRect();
      const button = node.querySelector(".composer-send")?.getBoundingClientRect();
      if (!field || !button) throw new Error("Composer controls missing");
      return { height: button.height, fieldHeight: field.height,
        topGap: Math.abs(field.top - button.top), bottomGap: Math.abs(field.bottom - button.bottom) };
    });
    await expect(send).toBeDisabled();
    for (const state of ["disabled", "enabled", "hover", "focus"]) {
      if (state === "enabled") await input.fill("Keep this draft");
      if (state === "hover") await send.hover();
      if (state === "focus") await send.focus();
      const box = await measure();
      expect(box.topGap, state).toBeLessThan(1);
      expect(box.bottomGap, state).toBeLessThan(1);
    }
    const single = await measure();
    await input.fill("First line\nSecond line\nThird line");
    await expect.poll(async () => (await measure()).fieldHeight).toBeGreaterThan(single.fieldHeight);
    expect((await measure()).height).toBe(single.height);
    await input.fill("Keep this draft");

    const trigger = page.getByRole("button", { name: "Add", exact: true });
    const anchor = await trigger.boundingBox();
    if (!anchor) throw new Error("Attachment trigger missing");
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Add to this message" });
    await expect(menu.getByRole("menuitem", { name: "Add file…" })).toBeVisible();
    await expect(menu.locator("[data-tooltip]")).toHaveCount(0);
    const bounds = await menu.boundingBox();
    if (!bounds) throw new Error("Attachment menu missing");
    expect(Math.abs(bounds.x - anchor.x)).toBeLessThan(1);
    expect(anchor.y - bounds.y - bounds.height).toBeGreaterThanOrEqual(7);
    expect(anchor.y - bounds.y - bounds.height).toBeLessThanOrEqual(9);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(760);
    // A native modal routes this second click through the backdrop.
    await page.mouse.click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(input).toHaveValue("Keep this draft");
  });
}

test("attachment menu supports keyboard, dismissal and file picker without losing the draft (#89)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html");
  const input = page.locator(".composer-input");
  await input.fill("An unfinished message");
  const trigger = page.getByRole("button", { name: "Add", exact: true });
  const menu = page.getByRole("menu", { name: "Add to this message" });
  const file = menu.getByRole("menuitem", { name: "Add file…" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(file).toBeFocused();
  await expect(file).toHaveCSS("outline-style", "solid");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(file).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(600, 100);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await expect(file).toBeFocused();
  const choosing = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const chooser = await choosing;
  await chooser.setFiles([]);
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveValue("An unfinished message");
});
