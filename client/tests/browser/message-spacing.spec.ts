import { expect, test } from "@playwright/test";

for (const scale of [100, 200]) {
  test(`room and DM prose use the same tight rhythm at ${scale}% (#92)`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("linger.interface.scale", String(value)), scale);
    await page.goto("/tests/fixtures/console.html?spacing");
    const measurements: unknown[] = [];
    for (const conversation of ["room", "dm"]) {
      if (conversation === "dm") {
        const navigation = page.getByRole("button", { name: "Navigation", exact: true });
        if (await navigation.isVisible()) await navigation.click();
        await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
        await expect(page.locator(".room-name")).toHaveText("Jules");
      }
      const messages = page.locator(".msg");
      await expect(messages).toHaveCount(4);
      const first = messages.first();
      await first.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await expect(first.locator(".md-p").first()).toHaveText("First line\nSecond line\nThird line");
      const geometry = await first.evaluate((node) => {
        const body = node.querySelector(".msg-body");
        const paragraphs = node.querySelectorAll(".md-p");
        const row = node.closest(".stream-row");
        if (!body || !row || !paragraphs[0] || !paragraphs[1]) throw new Error("Message layout missing");
        return {
          fontSize: parseFloat(getComputedStyle(body).fontSize),
          lineHeight: parseFloat(getComputedStyle(body).lineHeight),
          paragraphGap: parseFloat(getComputedStyle(paragraphs[1]).paddingTop),
          groupGap: parseFloat(getComputedStyle(row).paddingTop),
          threeLines: paragraphs[0].getBoundingClientRect().height,
        };
      });
      expect(geometry.fontSize).toBe(16 * scale / 100);
      expect(geometry.lineHeight / geometry.fontSize).toBeCloseTo(1.3);
      expect(Math.abs(geometry.threeLines - geometry.lineHeight * 3)).toBeLessThan(1);
      expect(geometry.paragraphGap).toBe(2 * scale / 100);
      expect(geometry.groupGap).toBe(8 * scale / 100);
      measurements.push(geometry);
      await expect(messages.nth(1).locator(".msg-head")).toHaveCount(0);
      await expect(messages.nth(2).locator(".msg-author")).toHaveText("Matt");
      await expect(messages.last().locator(".md-quote")).toContainText("Another quoted line");
      await expect(messages.last().locator(".md-list li")).toHaveCount(2);
      await expect(messages.last().locator(".md-code")).toHaveText("first code line\nsecond code line");
    }
    expect(measurements[1]).toEqual(measurements[0]);
  });
}
