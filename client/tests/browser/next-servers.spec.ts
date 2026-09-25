import { expect, type Locator, type Page, test } from "@playwright/test";

// The buddy list with several servers (tests/fixtures/next-list.html?servers):
// the prototype's three servers, each a section with its own header, line,
// menu and body. What they say, that they never say a number, that they fold
// and pin, and that they sit on the list's own grid.

test.use({ viewport: { width: 340, height: 820 } });

const GOOD = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";

async function open(page: Page, options = "") {
  await page.goto(`/tests/fixtures/next-list.html?servers${options}`);
  await page.evaluate(() => document.fonts.ready);
}

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const toggle = (page: Page, name: string) => section(page, name).locator(".nx-srv-toggle");
const lineOf = (page: Page, name: string) => section(page, name).locator(".nx-srv-line-text");
const opened = (page: Page) => page.locator("body").getAttribute("data-opened");

/** Text as a person reads it: whitespace collapsed. */
async function words(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, " ").trim();
}

test("one list, a section per server in your order, the first open and the rest folded", async ({ page }) => {
  await open(page);
  await expect(page.locator(".k-titlebar")).toContainText("Linger");
  await expect(page.locator(".nx-srv")).toHaveCount(3);
  const names = await page.locator(".nx-srv-name").allInnerTexts();
  expect(names).toEqual(["The Good Company", "Ashen Lanterns", "Casa da Ribeira"]);
  await expect(toggle(page, "The Good Company")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "Ashen Lanterns")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "Casa da Ribeira")).toHaveAttribute("aria-expanded", "false");
  // The top card keeps only what's true everywhere: you, and whether you're away.
  const you = page.getByRole("region", { name: "You" });
  await expect(you).toContainText("Matt");
  await expect(you).toContainText("around");
  await expect(you.getByRole("button", { name: "Away" })).toBeVisible();
  await expect(you).not.toContainText("fixing the porch light");
});

test("a folded server still shows its lights: one plain line about what's happening there", async ({ page }) => {
  await open(page, "&folded");
  expect(await words(lineOf(page, "The Good Company"))).toBe("Eli and Jules in #general");
  expect(await words(lineOf(page, "Ashen Lanterns"))).toBe("#raid-night in voice · room for one more");
  expect(await words(lineOf(page, "Casa da Ribeira"))).toBe("quiet · Rui's up");
  // Names in the line are drawn in their own faces.
  await expect(lineOf(page, "The Good Company").locator("[data-kit='Name']")).toHaveCount(2);
  // An open server's line says who you are there instead.
  await toggle(page, "Ashen Lanterns").click();
  expect(await words(lineOf(page, "Ashen Lanterns"))).toBe("you're Lamplighter here · healing tonight. be nice");
});

test("never shows a number, in any header or line", async ({ page }) => {
  for (const options of ["&folded", "&open", "&folded&quiet", "&folded&voice"]) {
    await open(page, options);
    const texts = await page.locator(".nx-srv-top").allInnerTexts();
    expect(texts.length).toBe(3);
    for (const text of texts) expect(text, options).not.toMatch(/\d/);
    expect(await page.locator(".nx-you").innerText()).not.toMatch(/\d/);
  }
});

test("a server's name is bold when something inside is new, and never while it's quiet", async ({ page }) => {
  const weights = () =>
    page.locator(".nx-srv-name").evaluateAll((names) => names.map((name) => Number(getComputedStyle(name).fontWeight)));
  await open(page, "&folded");
  // All three hold something new.
  expect(await weights()).toEqual([700, 700, 700]);
  await open(page, "&folded&quiet");
  expect(await weights()).toEqual([700, 500, 700]);
  await expect(toggle(page, "Ashen Lanterns")).toHaveAccessibleName("Ashen Lanterns, quiet");
  await expect(toggle(page, "Casa da Ribeira")).toHaveAccessibleName("Casa da Ribeira, something new");
  await expect(section(page, "Ashen Lanterns").locator(".nx-srv-quiet")).toBeVisible();
});

test("folds and unfolds by click and by keyboard, and each server's lists say whose they are", async ({ page }) => {
  await open(page, "&folded");
  await expect(page.getByRole("list", { name: "Rooms on Ashen Lanterns" })).toHaveCount(0);
  await toggle(page, "Ashen Lanterns").focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page, "Ashen Lanterns")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("list", { name: "Rooms on Ashen Lanterns" }).locator(":scope > li")).toHaveText([
    /raid-night/,
    /general/,
    /loot-council/,
    /lfg/,
  ]);
  await page.keyboard.press("Space");
  await expect(toggle(page, "Ashen Lanterns")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("list", { name: "Rooms on Ashen Lanterns" })).toHaveCount(0);
  // Opening a room says which server it's on.
  await toggle(page, "Casa da Ribeira").click();
  await page.getByRole("list", { name: "Rooms on Casa da Ribeira" }).getByRole("button", { name: /#fotos/ }).click();
  expect(await opened(page)).toBe(`room:${LISBON}:l-fotos`);
});

test("the server menu: Quiet, and moving a server up and down, with focus back on its button", async ({ page }) => {
  await open(page, "&folded");
  const menuButton = (name: string) => page.getByRole("button", { name: `${name} options` });

  // The first can't move up, the last can't move down.
  await menuButton("The Good Company").click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Move down"]);
  await page.keyboard.press("Escape");
  await expect(menuButton("The Good Company")).toBeFocused();
  await menuButton("Casa da Ribeira").click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Move up"]);
  await page.keyboard.press("Escape");

  // Quiet is an on/off item, ticked when on.
  await menuButton("Ashen Lanterns").click();
  const quiet = page.getByRole("menuitemcheckbox", { name: "Quiet" });
  await expect(quiet).toHaveAttribute("aria-checked", "false");
  await expect(quiet).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
  await expect(menuButton("Ashen Lanterns")).toBeFocused();
  await menuButton("Ashen Lanterns").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Quiet" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".k-menu-tick")).toHaveCount(1);

  // Move down, from the keyboard.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Move down" })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.locator(".nx-srv-name").allInnerTexts()).toEqual(["The Good Company", "Casa da Ribeira", "Ashen Lanterns"]);
  expect(await opened(page)).toBe(`quiet:${GUILD}:true,move:${GUILD}:1`);
  await expect(menuButton("Ashen Lanterns")).toBeFocused();
});

test("a long server's header and line stay pinned while you scroll through it, and let go after", async ({ page }) => {
  await open(page, "&open");
  const scroller = page.locator(".nx-list-scroll");
  const top = await scroller.evaluate((el) => el.getBoundingClientRect().top);
  const pinnedAt = async (name: string) => (await section(page, name).locator(".nx-srv-top").boundingBox())?.y ?? NaN;
  const guildStart = await section(page, "Ashen Lanterns").evaluate((el) => (el as HTMLElement).offsetTop);
  // Halfway through the guild's people: its header sits at the top of the list.
  await scroller.evaluate((el, y) => (el.scrollTop = y + 400), guildStart);
  await expect.poll(() => pinnedAt("Ashen Lanterns")).toBeLessThanOrEqual(top + 1);
  expect(await pinnedAt("Ashen Lanterns")).toBeGreaterThanOrEqual(top - 5);
  // The rows it covers are under it, not over it.
  const covered = await page.evaluate((y) => {
    const header = document.elementFromPoint(170, y + 20);
    return header?.closest(".nx-srv-top") !== null;
  }, top);
  expect(covered).toBe(true);
  // The server scrolled past has let go: its header went up with it.
  expect(await pinnedAt("The Good Company")).toBeLessThan(top - 40);
  // Back at the top, the guild's header is back in its place.
  await scroller.evaluate((el) => (el.scrollTop = 0));
  await expect.poll(() => pinnedAt("Ashen Lanterns")).toBeGreaterThan(top + 400);
});

test("headers and lines sit on the list's grid: names start with every other name, in every server", async ({ page }) => {
  await open(page, "&open");
  const x = (selector: string) =>
    page.locator(selector).evaluateAll((all) => all.map((node) => Math.round(node.getBoundingClientRect().left * 2) / 2));
  const serverNames = await x(".nx-srv-name");
  // Where a line's words start (a line you can click has a little padding around them).
  const lineTexts = await x(".nx-srv-line-text:not(.nx-srv-you), .nx-srv-you-is");
  const rowTitles = await x(".k-row-title");
  expect(new Set(serverNames).size).toBe(1);
  expect(new Set(lineTexts)).toEqual(new Set(serverNames));
  expect(new Set(rowTitles)).toEqual(new Set(serverNames));
  // The server's mark sits where a person's marker does.
  const centers = (selector: string) =>
    page.locator(selector).evaluateAll((all) =>
      all.map((node) => {
        const box = node.getBoundingClientRect();
        return Math.round((box.left + box.width / 2) * 2) / 2;
      }),
    );
  const marks = await centers(".nx-srv-mark");
  const slots = await centers(".k-row [data-kit='MarkerSlot']");
  expect(new Set(marks).size).toBe(1);
  expect(new Set(slots)).toEqual(new Set(marks));
  // Every header is a row high, every line a line high.
  const heights = (selector: string) => page.locator(selector).evaluateAll((all) => all.map((node) => node.getBoundingClientRect().height));
  expect(new Set(await heights(".nx-srv-toggle"))).toEqual(new Set([32]));
  expect(new Set(await heights(".nx-srv-line"))).toEqual(new Set([26]));
});

test("nothing is cut off at the list's width: long words end in an ellipsis", async ({ page }) => {
  for (const options of ["&open", "&folded", "&folded&voice"]) {
    await open(page, options);
    const clipped = await page.locator(".nx-srv-name, .nx-srv-line-text, .nx-you-text, .nx-voice-server-name").evaluateAll((all) =>
      all
        .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).textOverflow !== "ellipsis")
        .map((node) => node.textContent),
    );
    expect(clipped, options).toEqual([]);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide).toBeLessThanOrEqual(340);
  }
});

test.describe("away, with a choice of servers", () => {
  test("goes away where it's ticked, says where, and comes back from there", async ({ page }) => {
    await open(page, "&folded");
    await page.getByRole("button", { name: "Away" }).click();
    const editor = page.getByRole("dialog", { name: "Away message" });
    const boxes = editor.getByRole("checkbox");
    await expect(boxes).toHaveCount(3);
    for (const box of await boxes.all()) await expect(box).toBeChecked();
    await expect(editor.getByRole("checkbox", { name: /Ashen Lanterns as Lamplighter/ })).toBeVisible();
    await editor.getByRole("checkbox", { name: /Casa da Ribeira/ }).click();
    await expect(editor.getByRole("checkbox", { name: /Casa da Ribeira/ })).not.toBeChecked();
    await editor.getByRole("button", { name: "I'm away" }).click();
    await expect(editor).toHaveCount(0);
    expect(await opened(page)).toBe(`away:${GOOD}+${GUILD}:back after work`);
    const you = page.getByRole("region", { name: "You" });
    await expect(you.locator(".nx-you-text")).toHaveAttribute("title", "away on The Good Company and Ashen Lanterns");
    // Each server's section shows your away message there, when it's open.
    await toggle(page, "Ashen Lanterns").click();
    expect(await words(lineOf(page, "Ashen Lanterns"))).toBe("you're Lamplighter here · “back after work”");
    await you.getByRole("button", { name: "I'm back" }).click();
    await expect(you.getByRole("button", { name: "Away" })).toBeVisible();
    expect(await opened(page)).toBe(`away:${GOOD}+${GUILD}:back after work,back:${GOOD}+${GUILD}`);
  });

  test("a server that refuses says why under its own name, and the rest still go away", async ({ page }) => {
    await open(page, "&folded&awayfail");
    await page.getByRole("button", { name: "Away" }).click();
    const editor = page.getByRole("dialog", { name: "Away message" });
    await editor.getByRole("button", { name: "I'm away" }).click();
    await expect(editor.getByRole("alert")).toHaveText("Casa da Ribeira didn't answer. Try again in a moment.");
    await expect(editor).toBeVisible();
    await expect(page.getByRole("region", { name: "You" }).getByRole("button", { name: "I'm back" })).toBeVisible();
  });

  test("with nothing ticked there's nowhere to go away", async ({ page }) => {
    await open(page, "&folded");
    await page.getByRole("button", { name: "Away" }).click();
    const editor = page.getByRole("dialog", { name: "Away message" });
    for (const box of await editor.getByRole("checkbox").all()) await box.click();
    await expect(editor.getByRole("button", { name: "I'm away" })).toBeDisabled();
  });

  test("the editor with its servers fits inside the list window", async ({ page }) => {
    await open(page, "&folded");
    await page.getByRole("button", { name: "Away" }).click();
    const box = await page.getByRole("dialog", { name: "Away message" }).boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(340 - 8);
    expect(box.y + box.height).toBeLessThanOrEqual(820 - 8);
  });
});

test("your status on one server changes from that server's line", async ({ page }) => {
  await open(page, "&folded");
  await toggle(page, "Casa da Ribeira").click();
  await section(page, "Casa da Ribeira").getByRole("button", { name: /Change your status here/ }).click();
  const field = page.getByRole("textbox", { name: "Your status as Matt" });
  await expect(field).toBeFocused();
  await field.fill("fado tonight");
  await page.keyboard.press("Enter");
  expect(await words(lineOf(page, "Casa da Ribeira"))).toBe("you're Matt here · fado tonight");
  expect(await opened(page)).toBe(`line:${LISBON}:fado tonight`);
  await expect(section(page, "Casa da Ribeira").getByRole("button", { name: /Change your status here/ })).toBeFocused();
});

test("in voice, the voice bar says which server", async ({ page }) => {
  await open(page, "&folded&voice");
  const bar = page.getByRole("region", { name: "In voice in #general on The Good Company" });
  await expect(bar.locator(".nx-voice-server")).toHaveText("The Good Company");
});
