import { expect, type Page, test } from "@playwright/test";

// The themes (#964, SPEC §5.3): picked in Settings › Appearance › Theme,
// applied at once, kept on this computer or phone, and on the page before
// anything draws in every window opened afterwards. The Settings window with
// its wiring (tests/fixtures/next-settings-window.tsx), the phone's list
// (next-list-window.tsx?shell=phone) and the app's own page (next.html).
// Storage refusing a theme is in next-settings-window.spec.ts with the other
// Appearance choices (#782).

/** Each theme's window color (`--surface-window`, styles/tokens.css), as the page computes it. */
const WINDOW = {
  door: "rgb(19, 26, 40)",
  "after-dark": "rgb(9, 10, 13)",
  "porch-light": "rgb(28, 23, 20)",
  dusk: "rgb(33, 47, 88)",
  original: "rgb(1, 19, 51)",
} as const;
type Theme = keyof typeof WINDOW;

/** Each theme's lamp and green (`--lamp-1`, `--green-1`): two themes share The door's, and two don't. */
const LAMP: Record<Theme, string> = {
  door: "rgb(243, 181, 92)",
  "after-dark": "rgb(236, 173, 89)",
  "porch-light": "rgb(243, 181, 92)",
  dusk: "rgb(249, 188, 102)",
  original: "rgb(243, 181, 92)",
};
const GREEN: Record<Theme, string> = {
  door: "rgb(124, 201, 143)",
  "after-dark": "rgb(119, 186, 135)",
  "porch-light": "rgb(124, 201, 143)",
  dusk: "rgb(135, 210, 153)",
  original: "rgb(124, 201, 143)",
};

const NAMES: Record<Theme, string> = {
  door: "The door",
  "after-dark": "After dark",
  "porch-light": "Porch light",
  dusk: "Dusk",
  original: "The original",
};

const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
/** The page's own ground: what shows where nothing else is drawn. */
const ground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** What an iPhone's web view says it is (next-back-to-newest.spec.ts). */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
/** The page's popover color now, as `#rrggbbaa`: the share window's background (`core/shareWindow.ts`). */
const popover = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--surface-popover)";
    document.body.append(probe);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext("2d");
    if (!paint) throw new Error("no canvas");
    paint.fillStyle = getComputedStyle(probe).color;
    probe.remove();
    paint.fillRect(0, 0, 1, 1);
    return `#${[...paint.getImageData(0, 0, 1, 1).data].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  });
const themes = (page: Page) => page.getByRole("group", { name: "Theme" });
const choice = (page: Page, theme: Theme) => themes(page).getByRole("radio", { name: NAMES[theme], exact: true });

test.describe("on a computer", () => {
  test.use({ viewport: { width: 720, height: 640 } });

  async function settings(page: Page) {
    await page.goto("/tests/fixtures/next-settings-window.html?section=appearance");
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }

  test("picking a theme changes the page at once, and it's still chosen when Settings opens again", async ({ page }) => {
    await settings(page);
    await expect(themes(page).getByRole("radio")).toHaveCount(5);
    for (const theme of Object.keys(NAMES) as Theme[]) await expect(choice(page, theme)).toHaveCount(1);
    await expect(choice(page, "door")).toBeChecked();
    expect(await themeOf(page)).toBe("door");
    expect(await ground(page)).toBe(WINDOW.door);

    await choice(page, "dusk").check();
    await expect.poll(() => themeOf(page)).toBe("dusk");
    expect(await ground(page)).toBe(WINDOW.dusk);
    expect(await page.evaluate(() => window.localStorage.getItem("linger.next.theme"))).toBe("dusk");

    // Closed and opened again: the page starts in it, and the picker says so.
    await settings(page);
    expect(await themeOf(page)).toBe("dusk");
    await expect(choice(page, "dusk")).toBeChecked();
    expect(await ground(page)).toBe(WINDOW.dusk);
  });

  test("the arrow keys move through the themes, each applied as it's reached", async ({ page }) => {
    await settings(page);
    await choice(page, "door").focus();
    await page.keyboard.press("ArrowRight");
    await expect(choice(page, "after-dark")).toBeChecked();
    await expect.poll(() => themeOf(page)).toBe("after-dark");
    await page.keyboard.press("ArrowRight");
    await expect(choice(page, "porch-light")).toBeChecked();
    await expect.poll(() => themeOf(page)).toBe("porch-light");
    expect(await ground(page)).toBe(WINDOW["porch-light"]);
    await expect(choice(page, "porch-light")).toBeFocused();
  });

  // The page in Dusk, whose lamp and green differ from The door's: a picture
  // whose own theme shares The door's still shows The door's, not Dusk's.
  test("each theme's picture is in that theme's own colors, whatever the page's", async ({ page }) => {
    await settings(page);
    await choice(page, "dusk").check();
    await expect.poll(() => themeOf(page)).toBe("dusk");
    for (const theme of Object.keys(WINDOW) as Theme[]) {
      const card = themes(page).locator(".k-choice").filter({ has: page.getByRole("radio", { name: NAMES[theme], exact: true }) });
      const picture = card.locator(".k-choice-sample");
      await expect(picture).toHaveAttribute("aria-hidden", "true");
      const seen = await picture.evaluate((sample) => {
        const color = (selector: string) => {
          const part = sample.querySelector(selector);
          return part ? getComputedStyle(part).backgroundColor : null;
        };
        return {
          window: getComputedStyle(sample).backgroundColor,
          lamp: color("[data-row='lit'] .k-choice-sample-dot"),
          green: color("[data-row='selected'] .k-choice-sample-dot"),
        };
      });
      expect(seen, theme).toEqual({ window: WINDOW[theme], lamp: LAMP[theme], green: GREEN[theme] });
    }
  });

  test("a window opened afterwards starts in the theme chosen, before the app's code has run", async ({ page, context }) => {
    await settings(page);
    await choice(page, "after-dark").check();
    await expect.poll(() => themeOf(page)).toBe("after-dark");

    // The app's page with its code held back: what it shows then is all
    // next.html did before anything ran, which is what draws first.
    const first = await context.newPage();
    await first.route(/\/src\/next\/main\.tsx/, (route) => route.abort());
    await first.goto("/next.html");
    expect(await themeOf(first)).toBe("after-dark");
    expect(await first.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(WINDOW["after-dark"]);

    // And the whole window, drawn in it.
    const later = await context.newPage();
    await later.goto("/next.html");
    await expect.poll(() => ground(later)).toBe(WINDOW["after-dark"]);
    expect(await later.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(WINDOW["after-dark"]);
    expect(await themeOf(later)).toBe("after-dark");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 411, height: 914 } });

  async function appearance(page: Page) {
    const list = page.locator("[data-screen='list']");
    await list.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator(".nx-phone-over [data-screen='settings']");
    await settings.getByRole("navigation", { name: "Settings" }).getByText("Appearance").click();
    await expect(settings.locator(".nx-set-title")).toHaveText("Appearance");
    return settings;
  }

  test("the phone's Settings has the Theme picker, applied at once and still chosen when Settings opens again", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list-window.html?one&shell=phone");
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    const settings = await appearance(page);
    await expect(themes(page).getByRole("radio")).toHaveCount(5);
    await expect(choice(page, "door")).toBeChecked();
    await choice(page, "porch-light").check();
    await expect.poll(() => themeOf(page)).toBe("porch-light");
    expect(await ground(page)).toBe(WINDOW["porch-light"]);

    // Back to the list, and Settings again.
    await settings.getByRole("button", { name: "Back to Settings" }).click();
    await settings.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator(".nx-phone-over")).toHaveCount(0);
    await appearance(page);
    await expect(choice(page, "porch-light")).toBeChecked();
    expect(await themeOf(page)).toBe("porch-light");
  });

  test.describe("on an iPhone", () => {
    test.use({ userAgent: IPHONE });

    test("the share window's colors follow a theme picked in Settings", async ({ page }) => {
      await page.goto("/tests/fixtures/next-list-window.html?one&shell=phone");
      await expect(page.locator("[data-screen='list']")).toBeVisible();
      const written = () => page.evaluate(() => document.body.dataset.sharelist ?? null);
      await expect.poll(written).toBe(await popover(page));
      const before = await written();

      await appearance(page);
      await choice(page, "dusk").check();
      await expect.poll(() => themeOf(page)).toBe("dusk");
      // Nothing else changed: the list is written again for the look alone.
      await expect.poll(written).toBe(await popover(page));
      expect(await written()).not.toBe(before);
    });
  });

  test("the phone's page starts in the theme chosen, before the app's code has run", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("linger.next.theme", "original"));
    await page.route(/\/src\/next\/main\.tsx/, (route) => route.abort());
    await page.goto("/next.html?shell=phone");
    expect(await themeOf(page)).toBe("original");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(WINDOW.original);
  });
});
