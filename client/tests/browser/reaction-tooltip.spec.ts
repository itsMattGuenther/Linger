import { expect, test } from "@playwright/test";

const names = [
  "Jules",
  "Matt",
  "Eli",
  "Sam",
  "Robin Redwood",
  "Casey Thompson",
  "Avery Bennett",
  "Morgan Rivera",
];
const tooltipText = `${names.slice(0, -1).join(", ")} and ${names.at(-1)} — heart`;

for (const scenario of [
  { theme: "dark", scale: 100, interaction: "pointer", edge: "left" },
  { theme: "light", scale: 200, interaction: "keyboard", edge: "right" },
] as const) {
  test(`reaction tooltip fits ${scenario.edge} edge in ${scenario.theme} at ${scenario.scale}% with ${scenario.interaction}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 480 });
    await page.addInitScript(
      ({ scale, theme }) => {
        localStorage.setItem("linger.interface.scale", String(scale));
        localStorage.setItem("linger.theme", theme);
      },
      scenario,
    );
    await page.goto("/tests/fixtures/console.html?tooltip");
    const reaction = page.getByRole("button", { name: "heart reaction" });
    await reaction.scrollIntoViewIfNeeded();
    if (scenario.edge === "right") {
      await reaction.locator("..").evaluate((node) => {
        node.style.justifyContent = "flex-end";
      });
    }

    if (scenario.interaction === "pointer") await reaction.hover();
    else await reaction.focus();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText(tooltipText);
    await expect(reaction).not.toHaveAttribute("title");
    await expect(reaction).toHaveAttribute("aria-describedby", await tooltip.getAttribute("id") ?? "");
    await expect(reaction).toHaveAccessibleDescription(tooltipText);
    expect(await tooltip.innerText()).not.toMatch(/\d/);
    expect(await tooltip.evaluate((node) => node.parentElement === document.body)).toBe(true);

    const bounds = await tooltip.boundingBox();
    if (!bounds) throw new Error("reaction tooltip is not visible");
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(752);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(472);

    const styles = await tooltip.evaluate((node) => {
      const actual = getComputedStyle(node);
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.backgroundColor = root.getPropertyValue("--surface-2");
      probe.style.color = root.getPropertyValue("--text-primary");
      probe.style.borderColor = root.getPropertyValue("--control-border");
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const compared = {
        background: [actual.backgroundColor, expected.backgroundColor],
        text: [actual.color, expected.color],
        border: [actual.borderTopColor, expected.borderTopColor],
        font: [actual.fontFamily, getComputedStyle(document.body).fontFamily],
        padding: actual.padding,
        shadow: actual.boxShadow,
      };
      probe.remove();
      return compared;
    });
    expect(styles.background[0]).toBe(styles.background[1]);
    expect(styles.text[0]).toBe(styles.text[1]);
    expect(styles.border[0]).toBe(styles.border[1]);
    expect(styles.font[0]).toBe(styles.font[1]);
    expect(styles.padding).not.toBe("0px");
    expect(styles.shadow).toBe("none");

    if (scenario.interaction === "pointer") {
      await page.mouse.move(0, 0);
    } else {
      await page.keyboard.press("Tab");
    }
    await expect(tooltip).toHaveCount(0);
  });
}
