import { expect, test } from "@playwright/test";

const THEMES = ["dark", "light"] as const;
const SCALES = [100, 110, 125, 150, 175, 200] as const;

for (const theme of THEMES) {
  for (const scale of SCALES) {
    test(`reaction surfaces stay quiet in ${theme} at ${scale}% (#98)`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ savedScale, savedTheme }) => {
          localStorage.setItem("linger.interface.scale", String(savedScale));
          localStorage.setItem("linger.theme", savedTheme);
        },
        { savedScale: scale, savedTheme: theme },
      );
      await page.goto("/tests/fixtures/console.html");

      const mark = page.getByRole("button", { name: "heart reaction" });
      const colors = await mark.evaluate((node) => {
        const style = getComputedStyle(node);
        const fill = getComputedStyle(node, "::before");
        const root = getComputedStyle(document.documentElement);
        const resolveColor = (token: string): string => {
          const probe = document.createElement("span");
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          fontSize: Number.parseFloat(style.fontSize),
          fill: fill.backgroundColor,
          surface1: resolveColor("--surface-1"),
          surface2: resolveColor("--surface-2"),
          hairline: resolveColor("--hairline"),
          hairlineStrong: resolveColor("--hairline-strong"),
          focus: resolveColor("--focus-ring"),
          rootSize: root.fontSize,
        };
      });

      expect(colors.background).toBe(colors.surface1);
      expect(colors.border).toBe(colors.hairlineStrong);
      expect(colors.fill).toBe(colors.surface2);
      expect(colors.rootSize).toBe(`${(16 * scale) / 100}px`);
      await expect(mark.locator(".reaction-own")).toHaveText("✓");

      await page.evaluate(() =>
        document.dispatchEvent(new Event("fixture-reaction")),
      );
      await expect.poll(() =>
        mark.evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).fontSize),
        ),
      ).toBeGreaterThan(colors.fontSize);

      // Hovering a message shows its actions button and nothing else (#139).
      await mark.hover();
      await expect
        .poll(() =>
          mark.evaluate((node) => {
            const style = getComputedStyle(node);
            return [style.backgroundColor, style.borderColor];
          }),
        )
        .toEqual([colors.surface1, colors.hairlineStrong]);

      await mark.click();
      await expect(mark).toHaveAttribute("aria-pressed", "false");
      await expect(mark.locator(".reaction-own")).toHaveCount(0);
      await page.mouse.move(0, 0);
      await expect
        .poll(() => mark.evaluate((node) => getComputedStyle(node).borderColor))
        .toBe(colors.hairline);

      await mark.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(mark).toBeFocused();
      const focus = await mark.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          color: style.outlineColor,
          style: style.outlineStyle,
          width: style.outlineWidth,
        };
      });
      expect(focus).toEqual({
        color: colors.focus,
        style: "solid",
        width: "1px",
      });
    });
  }
}
