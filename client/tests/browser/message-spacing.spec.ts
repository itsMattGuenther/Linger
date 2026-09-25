import { expect, test } from "@playwright/test";

for (const scale of [100, 200]) {
  test(`room and DM messages have no hidden action rows at ${scale}% (#93)`, async ({ page }) => {
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
      await expect(messages).toHaveCount(6);
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
      await expect(messages.nth(3).locator(".md-quote")).toContainText("Another quoted line");
      await expect(messages.nth(3).locator(".md-list li")).toHaveCount(2);
      await expect(messages.nth(3).locator(".md-code")).toHaveText("first code line\nsecond code line");
      await messages.last().scrollIntoViewIfNeeded();
      const rows = await messages.evaluateAll((nodes) => nodes.map((node) => {
        const body = node.querySelector(".msg-body");
        const trigger = node.querySelector(".msg-actions-trigger");
        if (!body || !trigger) throw new Error("Message body or action target missing");
        return {
          top: node.getBoundingClientRect().top,
          bottom: node.getBoundingClientRect().bottom,
          height: node.getBoundingClientRect().height,
          bodyTop: body.getBoundingClientRect().top,
          indent: parseFloat(getComputedStyle(body).paddingLeft),
          border: parseFloat(getComputedStyle(body).borderLeftWidth),
          actionHeight: trigger.getBoundingClientRect().height,
          actionBottom: trigger.getBoundingClientRect().bottom,
        };
      }));
      for (const row of rows) {
        expect(row.border).toBe(0);
        expect(row.indent).toBe(14 * scale / 100);
        expect(row.actionHeight).toBe(24 * scale / 100);
        expect(row.actionBottom).toBeLessThanOrEqual(row.bottom);
      }
      // Measure complete virtual rows, not only paragraph line height. The old
      // invisible toolbar added a full line above every continuation.
      for (const index of [1, 3, 4, 5]) {
        const row = rows[index], previous = rows[index - 1];
        if (!row || !previous) throw new Error("Missing continuation");
        expect(Math.abs(row.bodyTop - row.top)).toBeLessThan(1);
        expect(Math.abs(row.top - previous.bottom)).toBeLessThan(1);
      }
      for (const row of rows.slice(4)) expect(row.height).toBe(24 * scale / 100);
      if (!rows[2] || !rows[1]) throw new Error("Missing sender change");
      expect(rows[2].top - rows[1].bottom).toBe(8 * scale / 100);
      measurements.push(rows.map(({ height, indent, border }) => ({ height, indent, border })));
    }
    expect(measurements.slice(2)).toEqual(measurements.slice(0, 2));
  });
}

test("message menu keeps reply, editing and confirmed deletion reachable", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?spacing");
  const message = page.locator(".msg").last();
  const trigger = message.getByRole("button", { name: "Actions for Matt's message" });
  const menu = page.getByRole("menu", { name: "Actions for Matt's message" });
  const open = async () => {
    await message.hover();
    await trigger.click();
    await expect(menu).toBeVisible();
  };

  await open();
  await menu.getByRole("menuitem", { name: "reply to Matt" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".composer-reply")).toContainText("Another short line.");
  await expect(page.locator(".composer-input")).toBeFocused();

  await open();
  await menu.getByRole("menuitem", { name: "edit", exact: true }).click();
  await expect(menu).toHaveCount(0);
  const editor = message.locator("textarea");
  await expect(editor).toHaveValue("Another short line.");
  await expect(editor).toBeFocused();
  await editor.press("Escape");

  // A dismissed confirmation must not survive when the menu reopens.
  await open();
  await menu.getByRole("menuitem", { name: "delete", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "delete for good" })).toBeFocused();
  await page.keyboard.press("Escape");
  await open();
  await expect(menu.getByRole("menuitem", { name: "delete for good" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "delete", exact: true }).click();
  await menu.getByRole("menuitem", { name: "keep", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "delete", exact: true })).toBeVisible();

  await page.evaluate(() => { document.documentElement.dataset.refuseWrites = "yes"; });
  await menu.getByRole("menuitem", { name: "delete", exact: true }).click();
  await menu.getByRole("menuitem", { name: "delete for good" }).click();
  await expect(menu).toHaveCount(0);
  await expect(message.getByRole("alert")).toHaveText("This change was refused.");
  await expect(message.locator(".msg-body")).toHaveText("Another short line.");
});
