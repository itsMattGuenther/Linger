import { expect, test, type Page } from "@playwright/test";
import { images } from "../fixtures/images";

async function expectWindowFit(page: Page) {
  const result = await page.getByRole("dialog").evaluate((dialog) => {
    const image = dialog.querySelector("img");
    const caption = dialog.querySelector(".att-expanded-name");
    if (!image || !caption) throw new Error("missing image or caption");
    const box = image.getBoundingClientRect();
    const label = caption.getBoundingClientRect();
    const overlay = dialog.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overlay: { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height },
      image: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      caption: { x: label.x, right: label.right, bottom: label.bottom },
      natural: { width: image.naturalWidth, height: image.naturalHeight },
    };
  });
  expect(result.overlay).toEqual({ x: 0, y: 0, ...result.viewport });
  expect(result.image.x).toBeGreaterThanOrEqual(0);
  expect(result.image.y).toBeGreaterThanOrEqual(0);
  expect(result.image.right).toBeLessThanOrEqual(result.viewport.width);
  expect(result.image.bottom).toBeLessThanOrEqual(result.viewport.height);
  expect(result.caption.x).toBeGreaterThanOrEqual(0);
  expect(result.caption.right).toBeLessThanOrEqual(result.viewport.width);
  expect(result.caption.bottom).toBeLessThanOrEqual(result.viewport.height);
  expect(result.image.width / result.image.height).toBeCloseTo(result.natural.width / result.natural.height, 2);
  expect(result.image.width).toBeLessThanOrEqual(result.natural.width);
  expect(result.image.height).toBeLessThanOrEqual(result.natural.height);
  expect(Math.abs(result.image.x + result.image.width / 2 - result.viewport.width / 2)).toBeLessThan(1);
  // The image and its caption are centered together, not inside the message row.
  expect(Math.abs((result.image.y + result.caption.bottom) / 2 - result.viewport.height / 2)).toBeLessThan(1);
}

for (const theme of ["dark", "light"]) {
  for (const scale of ["100", "150", "200"]) {
    for (const image of images) {
      test(`fits ${image.name.slice(0, 24)} in ${theme}/${scale}%`, async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 720 });
        const query = new URLSearchParams({ image: image.name, theme, scale });
        await page.goto(`/tests/fixtures/attachments.html?${query}`);
        await page.getByRole("button", { name: image.name }).click();
        const expanded = page.getByRole("dialog").locator("img");
        await expect(expanded).toBeVisible();
        await expect.poll(() => expanded.evaluate((element) =>
          element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        )).toBe(true);
        await expectWindowFit(page);
        await page.setViewportSize({ width: 760, height: 480 });
        await expectWindowFit(page);
        await page.setViewportSize({ width: 480, height: 320 });
        await expectWindowFit(page);
      });
    }
  }
}

test("Escape, image click, backdrop and close button dismiss without losing keyboard focus", async ({ page }) => {
  await page.goto("/tests/fixtures/attachments.html?image=small.png");
  const opener = page.getByRole("button", { name: "small.png" });
  await opener.focus();
  await opener.press("Enter");
  const close = page.getByRole("button", { name: "close image" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await page.getByRole("dialog").locator("img").click();
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await page.getByRole("dialog").click({ position: { x: 2, y: 2 } });
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await close.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});
