import { expect, type Page, test } from "@playwright/test";

// The phone app (SPEC §4.15): the same list window, opened as the phone's one
// window (`?shell=phone`, core/phone.ts), at a phone's size. Nothing on it may
// need a second window, and nothing desktop-only is offered.

test.use({ viewport: { width: 411, height: 914 } });

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** Every connection the page opened has had its `ready` (next-side.spec.ts says why, #355). */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
}

/** The phone, signed in to one server, with everything it asked for in. */
async function phone(page: Page) {
  await open(page, "?one&shell=phone");
  await settled(page);
}

const list = (page: Page) => page.locator("[data-screen='list']");
const screen = (page: Page) => page.locator("[data-screen='chat']");
const title = (page: Page) => screen(page).locator(".k-titlebar");
const back = (page: Page) => screen(page).getByRole("button", { name: "Back", exact: true });
const room = (page: Page, name: string) => page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: new RegExp(`^#${name}\\b`) });

/**
 * What reaches past the right edge of the screen: a page that scrolls
 * sideways, or anything drawn wider than the phone, words cut off at the
 * edge included. A line that ends in "…" is fine as long as the line itself
 * fits: its words run on inside it, but the "…" shows. Things parked off the
 * screen on purpose sit wholly past the edge, and anything inside them is
 * theirs.
 */
async function sticksOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    const out: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > edge) out.push(`the page scrolls sideways: ${root.scrollWidth} is wider than ${edge}`);
    for (const element of document.body.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right <= edge + 0.5) continue;
      if (getComputedStyle(element).visibility === "hidden") continue;
      let parked = box.left >= edge;
      let ellipsis = false;
      for (let up = element.parentElement; up && !parked && !ellipsis; up = up.parentElement) {
        const around = up.getBoundingClientRect();
        const style = getComputedStyle(up);
        parked = around.left >= edge;
        // Cut with a "…" by a line that fits: the "…" is on the screen.
        ellipsis = style.overflowX !== "visible" && style.textOverflow === "ellipsis" && around.right <= edge + 0.5;
      }
      if (parked || ellipsis) continue;
      const name = [element.tagName.toLowerCase(), ...element.classList].join(".");
      out.push(`${name} ends at ${Math.round(box.right)}, past ${edge}: "${(element.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out;
  });
}

test("has no close button of its own: a phone's app is closed the phone's way", async ({ page }) => {
  await open(page, "");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toBeVisible();
  await open(page, "?shell=phone");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toHaveCount(0);
});

test("opens Settings over the list, as its sections and then one section, without asking for a window", async ({ page }) => {
  // A computer asks the shell for Settings' own window.
  await open(page, "");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => (await did(page)).some((line) => line.startsWith("next_open_settings"))).toBe(true);
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);

  await open(page, "?shell=phone");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  await expect(settings).toBeVisible();
  expect((await did(page)).some((line) => line.includes("next_open_settings"))).toBe(false);

  // The sections first, the whole width: nothing a phone doesn't have.
  const sections = settings.getByRole("navigation", { name: "Settings" });
  await expect(sections).toBeVisible();
  await expect(settings.locator(".nx-set-main")).toBeHidden();
  await expect(sections).toContainText("Profile");
  await expect(sections).toContainText("Sound");
  await expect(sections).not.toContainText("Windows");
  await expect(sections).not.toContainText("Notifications");
  await expect(sections).not.toContainText("Voice");

  // One section, the whole width, with the way back.
  await sections.getByText("Appearance").click();
  await expect(sections).toBeHidden();
  await expect(settings.locator(".nx-set-title")).toHaveText("Appearance");
  await settings.getByRole("button", { name: "Back to Settings" }).click();
  await expect(sections).toBeVisible();

  // Back is the list again, as on every phone screen: no window to close.
  await expect(settings.getByRole("button", { name: "Close window" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
});

test("a room opens as the whole screen, with Back to the list and no tabs", async ({ page }) => {
  await phone(page);
  await room(page, "general").click();
  await expect(screen(page)).toBeVisible();
  await expect(list(page)).toBeHidden();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");

  // The bar is the way back and the room's name: no tab strip, nothing to
  // fold or pop out (SPEC §4.15).
  await expect(title(page)).toContainText("general");
  await expect(screen(page).getByRole("tablist")).toHaveCount(0);
  await expect(screen(page).getByRole("button", { name: "Fold back to your list" })).toHaveCount(0);
  await expect(screen(page).getByRole("button", { name: "Open in its own window" })).toHaveCount(0);

  await back(page).click();
  await expect(list(page)).toBeVisible();
  await expect(screen(page)).toHaveCount(0);
  // Nothing was left behind to unfold again.
  await expect(page.getByRole("button", { name: "Show your conversations" })).toHaveCount(0);

  // A computer keeps its tabs beside the list, as before.
  await open(page, "?one");
  await settled(page);
  await room(page, "general").click();
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
});

test("screens stack: a search hit opens over Search, and Back goes back down through them", async ({ page }) => {
  await phone(page);
  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(title(page)).toHaveText("Search");
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("moon");
  await page.locator(".nx-hit-main").first().click();
  await expect(title(page)).toContainText("general");
  await expect(page.getByRole("log")).toContainText("that's the moon");

  await back(page).click();
  await expect(title(page)).toHaveText("Search");
  // As it was left, and without the cursor in the box: on a phone that
  // would bring the keyboard up, and the next Back would only lower it.
  const words = page.getByRole("textbox", { name: "Search", exact: true });
  await expect(words).toHaveValue("moon");
  await expect(page.locator(".nx-hit-main").first()).toBeVisible();
  await expect(words).not.toBeFocused();
  await back(page).click();
  await expect(list(page)).toBeVisible();
  await expect(screen(page)).toHaveCount(0);

  // Opened again from the list, Search starts fresh.
  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(words).toHaveValue("");
  await back(page).click();

  // Media opens the same way, straight over the list again.
  await list(page).getByRole("button", { name: "Media", exact: true }).click();
  await expect(title(page)).toHaveText("Media");
  await back(page).click();
  await expect(list(page)).toBeVisible();
});

test("nothing reaches past the edge of the phone's screen, on any screen", async ({ page }) => {
  await phone(page);
  expect(await sticksOut(page), "the list").toEqual([]);

  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  expect(await sticksOut(page), "a room").toEqual([]);
  await back(page).click();

  await page.getByRole("list", { name: "People here" }).getByRole("button", { name: /^Jules/ }).first().click();
  await expect(title(page)).toContainText("Jules");
  expect(await sticksOut(page), "a DM").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Media", exact: true }).click();
  await expect(screen(page).locator(".nx-pane-other")).toBeVisible();
  expect(await sticksOut(page), "Media").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("porch");
  await expect(page.locator(".nx-hit-main").first()).toBeVisible();
  expect(await sticksOut(page), "Search").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  const sections = settings.getByRole("navigation", { name: "Settings" });
  await expect(sections).toBeVisible();
  expect(await sticksOut(page), "Settings").toEqual([]);
  const names = (await sections.getByRole("tab").allTextContents()).map((name) => name.trim());
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) {
    await sections.getByRole("tab", { name, exact: true }).click();
    await expect(settings.locator(".nx-set-title")).toHaveText(name);
    expect(await sticksOut(page), `Settings, ${name}`).toEqual([]);
    await settings.getByRole("button", { name: "Back to Settings" }).click();
  }
});
