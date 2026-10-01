import { expect, type Page, test } from "@playwright/test";

// The focus ring is the keyboard's (#375). Coming back to the window, from
// another workspace or with Alt+Tab, WebKitGTK puts focus back as if from the
// keyboard, and the ring lit up on whatever had last been clicked. So the app
// keeps track of how its window was last used (core/inputMode.ts), and the
// ring follows that.

/** A color as this browser writes it, from a token. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

test("every window follows how it was last used: a click, a key, and a modifier alone changes nothing (#375)", async ({ page }) => {
  await page.goto("/next.html");
  const mode = () => page.evaluate(() => document.documentElement.dataset.input ?? null);
  // Nothing until the first click or key: the ring shows as the browser decides.
  expect(await mode()).toBeNull();
  await page.mouse.click(4, 4);
  expect(await mode()).toBe("pointer");
  // Super, Shift or Control on their own are the start of a shortcut, often the desktop's.
  for (const key of ["Shift", "Control", "Meta"]) await page.keyboard.press(key);
  expect(await mode()).toBe("pointer");
  await page.keyboard.press("Tab");
  expect(await mode()).toBe("keyboard");
  await page.mouse.click(4, 4);
  expect(await mode()).toBe("pointer");
});

test("after a click the ring stays off where the browser would show it; a key brings it back; a place you type into keeps it (#375)", async ({ page }) => {
  await page.goto("/tests/fixtures/kit.html");
  await page.evaluate(() => document.fonts.ready);
  await page.locator("main").click({ position: { x: 2, y: 2 } });
  // To a button by the keyboard, so the browser shows its ring.
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.tagName === "BUTTON")) break;
  }
  const ring = () => page.evaluate(() => (document.activeElement ? getComputedStyle(document.activeElement).outlineColor : ""));
  const lamp = await token(page, "--focus");
  expect(await ring()).toBe(lamp);
  // The window comes back after a click: the same focus, and no ring.
  await page.evaluate(() => {
    document.documentElement.dataset.input = "pointer";
  });
  expect(await ring()).toBe("rgba(0, 0, 0, 0)");
  await page.evaluate(() => {
    document.documentElement.dataset.input = "keyboard";
  });
  expect(await ring()).toBe(lamp);
  // Somewhere you type keeps its ring after a click: it says where the words go.
  await page.evaluate(() => {
    document.documentElement.dataset.input = "pointer";
    const box = document.createElement("textarea");
    box.id = "typing-probe";
    document.querySelector("main")?.append(box);
    box.focus();
  });
  expect(await page.locator("#typing-probe").evaluate((node) => getComputedStyle(node).outlineColor)).toBe(lamp);
});
