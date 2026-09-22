import { expect, test, type Locator, type Page } from "@playwright/test";

async function openSettings(page: Page, section: string) {
  const navigation = page.getByRole("button", { name: "Navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: section, exact: true }).click();
}

async function assertActionsClear(message: Locator) {
  // Sample one layout frame: opening reaction choices can scroll the measured
  // virtual row between separate browser calls.
  const { actions, body, bounds, heading } = await message.evaluate((node) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const actions = node.querySelector(".msg-actions-trigger");
    const body = node.querySelector(".msg-body");
    const heading = node.querySelector(".msg-head");
    if (!actions || !body) throw new Error("Missing message geometry");
    return {
      actions: rect(actions),
      body: rect(body),
      bounds: rect(node),
      heading: heading ? rect(heading) : null,
    };
  });
  expect(actions.x).toBeGreaterThanOrEqual(body.x + body.width);
  expect(actions.y).toBeGreaterThanOrEqual(bounds.y);
  expect(actions.y + actions.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  expect(actions.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(actions.x + actions.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  if (heading) {
    const separate = actions.x >= heading.x + heading.width - 1 ||
      actions.y >= heading.y + heading.height - 1;
    expect(separate).toBe(true);
  }
}

for (const [width, height, scale] of [[1100, 720, 100], [760, 480, 100], [760, 480, 200]] as const) {
  test(`message actions preserve text and hover geometry at ${width}px / ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("linger.interface.scale", String(value)), scale);
    await page.goto("/tests/fixtures/console.html?qa");
    const messages = page.locator(".msg");
    await expect(messages.last()).toContainText("A grouped continuation");
    await page.evaluate(() => document.fonts.ready);
    for (const message of [messages.nth(7), messages.last()]) {
      const body = message.locator(".msg-body");
      await body.scrollIntoViewIfNeeded();
      const heightBefore = await message.evaluate((node) => node.getBoundingClientRect().height);
      await body.hover();
      const trigger = message.getByRole("button", { name: /^Actions for/ });
      await expect(trigger).toHaveCSS("opacity", "1");
      await assertActionsClear(message);
      expect(await message.evaluate((node) => node.getBoundingClientRect().height)).toBe(heightBefore);
      await trigger.focus();
      await page.mouse.move(0, 0);
      await expect(trigger).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: /^Actions for/ });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^react to/ })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("menuitem", { name: /^react with/ })).toHaveCount(12);
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      expect(await message.evaluate((node) => node.getBoundingClientRect().height)).toBe(heightBefore);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.mouse.click(1, 1);
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  });
}

test("legacy message fonts fall back to sans while names and inline code keep their faces", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?qa");
  const bodies = page.locator(".msg-body");
  await expect(bodies).toHaveCount(9);
  await expect(bodies.last()).toHaveCSS("font-family", /Geist Sans/);
  await expect(page.locator(".msg-author").last()).toHaveCSS("font-family", /Geist Mono/);
  await expect(bodies.nth(6)).toHaveCSS("font-family", /Geist Sans/);
  await expect(bodies.nth(5)).toHaveCSS("font-family", /IBM Plex Sans/);
  await expect(bodies.last().locator("code")).toHaveCSS("font-family", /Geist Mono/);
  await openSettings(page, "Profile");
  const choices = page.locator(".style-row").filter({ has: page.getByText("your messages", { exact: true }) });
  await expect(choices.getByRole("button")).toHaveText([
    "the reading face", "Geist Sans", "IBM Plex Sans", "Inter", "Space Grotesk",
  ]);
  await expect(choices.getByRole("button", { name: "the reading face", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".style-row").filter({ has: page.getByText("font", { exact: true }) }).getByRole("button"))
    .toHaveCount(12);
});

for (const width of [1100, 760]) {
  test(`destinations share headings and dismiss controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/tests/fixtures/console.html");
    const styles: unknown[] = [];
    for (const destination of ["Search", "Media", "Settings"]) {
      await page.getByRole("button", { name: destination, exact: true }).click();
      const header = page.locator(".destination-header");
      const heading = header.getByRole("heading", { name: destination, exact: true });
      const close = header.getByRole("button", { name: /^Close/ });
      await expect(heading).toBeVisible();
      await expect(close).toHaveText("Close");
      styles.push(await header.evaluate((node) => {
        const title = node.querySelector("h2");
        const button = node.querySelector("button");
        if (!title || !button) throw new Error("Incomplete destination header");
        const titleStyle = getComputedStyle(title);
        const buttonStyle = getComputedStyle(button);
        return [titleStyle.fontFamily, titleStyle.fontSize, titleStyle.fontWeight,
          titleStyle.textTransform, button.getBoundingClientRect().height,
          buttonStyle.padding, buttonStyle.borderRadius];
      }));
      await close.focus();
      await page.keyboard.press("Enter");
      await expect(header).toHaveCount(0);
      await expect(page.locator(".composer-input")).toBeVisible();
    }
    expect(styles[1]).toEqual(styles[0]);
    expect(styles[2]).toEqual(styles[0]);
  });
}

for (const scale of [100, 200]) {
  test(`sound switches share a column at ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.addInitScript((value) => localStorage.setItem("linger.interface.scale", String(value)), scale);
    await page.goto("/tests/fixtures/console.html");
    await openSettings(page, "Sound & Voice");
    const tracks = page.locator(".sound-settings .switch-track");
    await expect(tracks).toHaveCount(7);
    const columns = await tracks.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
    expect(Math.max(...columns) - Math.min(...columns)).toBeLessThan(1);
    // Changes still use the labelled switch and persist after the layout fix.
    const quiet = page.getByRole("switch", { name: "Quiet hours", exact: true });
    await quiet.check();
    await expect(quiet).toBeChecked();
    await page.reload();
    await openSettings(page, "Sound & Voice");
    await expect(quiet).toBeChecked();
  });
}
