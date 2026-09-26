import { expect, type Page, test } from "@playwright/test";

// The media collection in the new client (tests/fixtures/next-media.tsx),
// measured against docs/design/system.md and driven like a person would: the
// grid, the filters, stars, the way back to each message, the keyboard, the
// states, and several servers. What a tile says is unit-tested in
// src/next/core/media.test.ts.

const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-media.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='media']")).toBeVisible();
  await expect(page.locator("body[data-ready='yes']")).toBeAttached();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|").filter((line) => line !== "");
}

async function asks(page: Page): Promise<string[]> {
  return (await did(page)).filter((line) => line.startsWith("media "));
}

const tiles = (page: Page) => page.locator(".nx-tile-open");
const tile = (page: Page, name: string) => page.locator(".nx-tile", { has: page.locator(".nx-tile-title", { hasText: name }) });
const line = (page: Page) => page.locator(".nx-media-line");
const labels = (page: Page) => tiles(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));

async function loaded(page: Page, count: number) {
  await expect(tiles(page)).toHaveCount(count);
  await expect(line(page)).not.toHaveText("Loading media…");
}

test.describe("the grid", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("holds every kind shared, starred first, then newest", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    expect((await labels(page)).map((label) => label.split(", shared by")[0])).toEqual([
      "Image, moon-over-the-porch.png",
      "Audio, rain-sounds.mp3",
      "Link, Millrace River Trail — 4.2 mi loop",
      "Image, speakers.png",
      "File, river-loop-trail-map.pdf",
      "Pinned message, saturday walk, 9am? meet at the trailhead",
      "Video, porch-timelapse.mp4",
    ]);
    await expect(tiles(page).first()).toHaveAttribute("aria-label", /, starred$/);
    // One ask, and a short page is the end: no Show older.
    expect(await asks(page)).toEqual(["media kind= author= since= until= before="]);
    await expect(page.getByRole("button", { name: "Show older" })).toHaveCount(0);
  });

  test("every tile says who, where and when, and leads back to its message", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    const speakers = tile(page, "speakers.png");
    await expect(speakers.locator(".nx-tile-who")).toHaveText("Jules");
    await expect(speakers.locator(".nx-tile-where")).toHaveText("#general");
    await expect(speakers.locator(".nx-tile-date")).toHaveText(/Sep 25, 2026/);
    await expect(speakers.locator(".nx-tile-size")).toHaveText("180 KB");
    await expect(speakers.locator(".nx-tile-open")).toHaveAttribute("title", /September 25, 2026/);
    await speakers.locator(".nx-tile-open").click();
    expect(await did(page)).toContain("open r-general m000007");
    await tile(page, "saturday walk").locator(".nx-tile-open").click();
    expect(await did(page)).toContain("open r-plans m000021");
  });

  test("a link opens in the browser, a file downloads, and a picture only opens its message", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    await tile(page, "Millrace").getByRole("button", { name: /^Open Millrace River Trail .* in your browser$/ }).click();
    expect(await did(page)).toContain("link https://millrace-trail.org/river-loop");
    await tile(page, "river-loop-trail-map.pdf").getByRole("button", { name: "Download river-loop-trail-map.pdf" }).click();
    expect(await did(page)).toContain("download river-loop-trail-map.pdf");
    await expect(tile(page, "speakers.png").getByRole("button", { name: /^Download/ })).toHaveCount(0);
    // Only an upload can be starred: a link or a pin has nothing to keep.
    await expect(tile(page, "Millrace").getByRole("button", { name: /^Star/ })).toHaveCount(0);
    await expect(tile(page, "saturday walk").getByRole("button", { name: /^Star/ })).toHaveCount(0);
    await expect(tile(page, "rain-sounds.mp3").getByRole("button", { name: "Star rain-sounds.mp3" })).toHaveCount(1);
  });

  test("pictures load lazily into faces already the right size", async ({ page }) => {
    // Nothing ever answers for the pictures.
    await page.route("**/__media/**", () => undefined);
    await open(page, "?lazy");
    await loaded(page, 7);
    const images = page.locator(".nx-tile-face img");
    for (const img of await images.all()) {
      await expect(img).toHaveAttribute("loading", "lazy");
      expect(await img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(false);
    }
    await expect(page.locator(".nx-tile-face[data-face='image'] img").first()).toHaveAttribute("width", "300");
    await expect(page.locator(".nx-tile-face[data-face='image'] img").first()).toHaveAttribute("height", "400");
    const faces = await page.locator(".nx-tile-face").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((box) => [box.width, box.height]));
    for (const [width, height] of faces) {
      expect(width).toBeGreaterThan(100);
      expect(Math.abs((width ?? 0) * 0.75 - (height ?? 0))).toBeLessThan(1);
    }
  });
});

test.describe("filters", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("narrow by kind, person and dates, and say when nothing matches", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    const images = page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Images", exact: true });
    await images.click();
    await expect(images).toHaveAttribute("aria-pressed", "true");
    await loaded(page, 2);
    expect((await asks(page)).at(-1)).toBe("media kind=image author= since= until= before=");

    await page.getByRole("combobox", { name: "Shared by" }).selectOption({ label: "Callie" });
    await loaded(page, 1);
    expect((await asks(page)).at(-1)).toBe("media kind=image author=u-callie since= until= before=");

    await page.getByLabel("From", { exact: true }).fill("2026-09-25");
    await expect(page.locator(".nx-media-empty")).toContainText("Nothing here matches those filters.");
    const since = new Date(2026, 8, 25).getTime();
    expect((await asks(page)).at(-1)).toBe(`media kind=image author=u-callie since=${since} until= before=`);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await loaded(page, 7);
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
  });

  test("a date typed a digit at a time asks once, after a pause", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    const before = (await asks(page)).length;
    await page.getByLabel("Until", { exact: true }).click();
    await page.keyboard.type("09242026", { delay: 30 });
    await expect(page.getByLabel("Until", { exact: true })).toHaveValue("2026-09-24");
    await expect.poll(async () => (await asks(page)).length).toBe(before + 1);
    await page.waitForTimeout(500);
    expect((await asks(page)).length).toBe(before + 1);
    await loaded(page, 4);
  });

  test("a range that ends before it starts says so, and doesn't ask", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    await page.getByLabel("From", { exact: true }).fill("2026-09-25");
    await loaded(page, 3);
    const before = (await asks(page)).length;
    // The field's own limit stops a picked day; a typed one can still land here.
    await page.getByLabel("Until", { exact: true }).evaluate((input: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "2026-09-24");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(line(page)).toHaveText("The dates are the wrong way round: the first is after the second.");
    await expect(line(page)).toHaveAttribute("data-problem", "");
    await page.waitForTimeout(500);
    expect((await asks(page)).length).toBe(before);
  });
});

test.describe("stars", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("light only once the server takes them, and the tile stays where it is", async ({ page }) => {
    await open(page, "?slowstar");
    await loaded(page, 7);
    const star = tile(page, "speakers.png").getByRole("button", { name: "Star speakers.png" });
    const before = await labels(page);
    await star.click();
    expect(await did(page)).toContain("star a-speakers on");
    await expect(line(page)).toHaveText("Starring…");
    await expect(star).toBeDisabled();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(line(page)).toHaveText("Starred. It won’t expire.", { timeout: 3000 });
    const lit = tile(page, "speakers.png").getByRole("button", { name: "Take the star off speakers.png" });
    await expect(lit).toHaveAttribute("aria-pressed", "true");
    await expect(lit).toBeEnabled();
    // Same place, now said to be starred.
    const after = await labels(page);
    expect(after.map((label) => label.replace(/, starred$/, ""))).toEqual(before.map((label) => label.replace(/, starred$/, "")));
    expect(after[3]).toMatch(/, starred$/);

    await lit.click();
    await expect(line(page)).toHaveText("Took the star off.", { timeout: 3000 });
    expect(await did(page)).toContain("star a-speakers off");
    await expect(tile(page, "speakers.png").getByRole("button", { name: "Star speakers.png" })).toHaveAttribute("aria-pressed", "false");
  });

  test("a refused star stays dark and says why", async ({ page }) => {
    await open(page, "?starfail");
    await loaded(page, 7);
    const star = tile(page, "rain-sounds.mp3").getByRole("button", { name: "Star rain-sounds.mp3" });
    await star.click();
    await expect(line(page)).toHaveText("Only files can be starred, and this one has gone.");
    await expect(line(page)).toHaveAttribute("data-problem", "");
    await expect(star).toHaveAttribute("aria-pressed", "false");
  });

  test("starred things come first on the next load", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    await tile(page, "porch-timelapse.mp4").getByRole("button", { name: "Star porch-timelapse.mp4" }).click();
    await expect(line(page)).toHaveText("Starred. It won’t expire.");
    await page.getByRole("button", { name: "Video", exact: true }).click();
    await page.getByRole("button", { name: "Everything", exact: true }).click();
    await loaded(page, 7);
    // Among the starred, newest first: the moon, then the timelapse.
    const said = await labels(page);
    expect(said[0]).toMatch(/^Image, moon-over-the-porch\.png, .*, starred$/);
    expect(said[1]).toMatch(/^Video, porch-timelapse\.mp4, .*, starred$/);
  });
});

test.describe("the keyboard", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("arrows move through the tiles, by row up and down, one tile in the tab order, and Enter opens", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    await expect(page.locator(".nx-tile-open[tabindex='0']")).toHaveCount(1);
    // The buttons of tiles you aren't on are out of the tab order too.
    await expect(page.locator(".nx-tile-actions button:not([tabindex='-1'])")).toHaveCount(1);
    await tiles(page).first().focus();
    const across = await tiles(page).evaluateAll((nodes) => nodes.filter((node) => Math.abs(node.getBoundingClientRect().top - (nodes[0]?.getBoundingClientRect().top ?? 0)) < 1).length);
    expect(across).toBe(4);
    await page.keyboard.press("ArrowRight");
    await expect(tiles(page).nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(tiles(page).nth(5)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(tiles(page).nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(tiles(page).nth(6)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tiles(page).nth(6)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tiles(page).nth(0)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tiles(page).nth(0)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(tiles(page).nth(3)).toBeFocused();
    await expect(tiles(page).nth(3)).toHaveAttribute("tabindex", "0");
    // Tab reaches the tile's own buttons, then leaves the grid.
    await page.keyboard.press("Tab");
    await expect(tile(page, "speakers.png").getByRole("button", { name: "Star speakers.png" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    expect(await did(page)).toContain("open r-general m000007");
  });
});

test.describe("states", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("says it's loading until the first page comes", async ({ page }) => {
    await open(page, "?loading");
    await expect(line(page)).toHaveText("Loading media…");
    await page.waitForTimeout(300);
    await expect(tiles(page)).toHaveCount(0);
    await expect(page.locator(".nx-media-empty")).toHaveCount(0);
  });

  test("an empty collection says good things collect here", async ({ page }) => {
    await open(page, "?empty");
    await expect(page.locator(".nx-media-empty-title")).toHaveText("Good things collect here.");
    await expect(page.locator(".nx-media-empty-line")).toHaveText("Photos, files and links from your conversations will appear here.");
  });

  test("says what went wrong, in the server's words", async ({ page }) => {
    await open(page, "?fail");
    await expect(line(page)).toHaveText("The server is busy. Try again in a moment.");
    await expect(line(page)).toHaveAttribute("data-problem", "");
    await expect(line(page)).toHaveAttribute("role", "status");
    await expect(page.locator(".nx-media-empty")).toHaveCount(0);
  });

  test("a refused page keeps what was showing", async ({ page }) => {
    await open(page, "?failsecond");
    await loaded(page, 7);
    await page.getByRole("button", { name: "Images", exact: true }).click();
    await expect(line(page)).toHaveText("The server is busy. Try again in a moment.");
    await expect(tiles(page)).toHaveCount(7);
  });

  test("says how long this server keeps files", async ({ page }) => {
    await open(page);
    await loaded(page, 7);
    await expect(line(page)).toHaveText("Files go after a year here. Starred ones stay.");
  });

  test("pages older things on, asking after the last one", async ({ page }) => {
    await open(page, "?many");
    await loaded(page, 60);
    const older = page.getByRole("button", { name: "Show older" });
    await older.click();
    await loaded(page, 120);
    expect((await asks(page)).at(-1)).toMatch(/before=a-many-\d+$/);
    await older.click();
    await loaded(page, 157);
    await expect(older).toHaveCount(0);
  });
});

test.describe("several servers", () => {
  test.use({ viewport: { width: 780, height: 720 } });

  test("with one there's nothing to pick", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("combobox", { name: "Server" })).toHaveCount(0);
  });

  test("every server's things merge, starred first, each saying which server it's from", async ({ page }) => {
    await open(page, "?servers");
    await loaded(page, 10);
    expect((await asks(page)).sort()).toEqual([`media ${GUILD} kind= author= since= until= before=`, `media ${LISBON} kind= author= since= until= before=`, "media kind= author= since= until= before="].sort());
    const said = await labels(page);
    expect(said[0]).toMatch(/^Image, moon-over-the-porch\.png, shared by Callie in #general on The Good Company, .*, starred$/);
    expect(said.filter((label) => label.includes(" on Ashen Lanterns,"))).toHaveLength(2);
    expect(said.filter((label) => label.includes(" on Casa da Ribeira,"))).toHaveLength(1);
    await expect(tile(page, "raid-wipe.png").locator(".nx-tile-server")).toHaveText("Ashen Lanterns");
    await expect(page.locator(".nx-tile .nx-scope-mark")).toHaveCount(10);
    // People are per server.
    await expect(page.getByRole("combobox", { name: "Shared by" })).toHaveCount(0);
    await expect(page.locator(".nx-media-who-off")).toHaveText("Pick one server to choose a person.");
    await expect(line(page)).toHaveText("Starred files don’t expire.");
    await tile(page, "raid-wipe.png").locator(".nx-tile-open").click();
    expect(await did(page)).toContain(`open ${GUILD} a-raid-night m000913`);
    await tile(page, "loot-council.xlsx").getByRole("button", { name: "Star loot-council.xlsx" }).click();
    expect(await did(page)).toContain(`star ${GUILD} g-loot on`);
  });

  test("picking one server asks only it, and brings its person filter and keep line", async ({ page }) => {
    await open(page, "?servers");
    await loaded(page, 10);
    await page.getByRole("combobox", { name: "Server" }).selectOption({ label: "Ashen Lanterns" });
    await expect.poll(async () => (await asks(page)).at(-1)).toBe(`media ${GUILD} kind= author= since= until= before=`);
    await loaded(page, 2);
    await expect(page.locator(".nx-tile .nx-scope-mark")).toHaveCount(0);
    await expect(line(page)).toHaveText("This server keeps files for good.");
    await expect(page.getByRole("combobox", { name: "Shared by" })).toBeVisible();
    // People are per server: switching lets go of the one you picked.
    await page.getByRole("combobox", { name: "Shared by" }).selectOption({ label: "Kestrel" });
    await expect.poll(async () => (await asks(page)).at(-1)).toBe(`media ${GUILD} kind= author=a-kestrel since= until= before=`);
    await page.getByRole("combobox", { name: "Server" }).selectOption({ label: "Casa da Ribeira" });
    await expect.poll(async () => (await asks(page)).at(-1)).toBe(`media ${LISBON} kind= author= since= until= before=`);
    await expect(page.getByRole("combobox", { name: "Shared by" })).toHaveValue("");
  });

  test("starts on the server it was opened from", async ({ page }) => {
    await open(page, "?servers&start=lisbon");
    await expect(page.getByRole("combobox", { name: "Server" })).toHaveValue(LISBON);
    await loaded(page, 1);
    await expect(line(page)).toHaveText("Files go after 3 months here. Starred ones stay.");
  });
});

/** Every kit control is 24, 32 or 40px tall. */
async function misSized(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-kit-control]")].flatMap((node) => {
      const box = node.getBoundingClientRect();
      if (box.width === 0) return [];
      return [24, 32, 40].includes(Math.round(box.height * 100) / 100) ? [] : [`${node.textContent?.trim() || node.getAttribute("aria-label")}: ${box.height}`];
    }),
  );
}

/** Text cut off without an ellipsis, or running past the pane (kit.spec's rule, over media). */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const pane = document.querySelector("[data-screen='media']");
    if (!pane) return ["no pane"];
    const right = pane.getBoundingClientRect().right;
    for (const el of pane.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1) continue;
      // What a clipping box (an ellipsized line) hides isn't past anything.
      let seen = box.right;
      for (let up = el.parentElement; up && up !== pane; up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== "visible") seen = Math.min(seen, up.getBoundingClientRect().right);
      }
      if (seen > right + 1) out.push(`"${el.textContent?.trim().slice(0, 40)}" runs past the pane's edge`);
      // Its own words, or words in inline pieces (marked matches, a name)
      // that sit on its lines, are this box's to end in "…".
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      const inlineText = el.children.length > 0 && !!el.textContent?.trim() && [...el.children].every((child) => getComputedStyle(child).display.startsWith("inline"));
      if (!ownText && !inlineText) continue;
      const ellipsizes = !/flex|grid/.test(style.display) && style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
      if (el.scrollWidth > el.clientWidth + 1 && style.display !== "inline" && !ellipsizes) {
        out.push(`"${el.textContent?.trim().slice(0, 40)}" overflows its box without an ellipsis`);
      }
    }
    return out;
  });
}

for (const width of [340, 780]) {
  test.describe(`built on the system, ${width} wide`, () => {
    test.use({ viewport: { width, height: 720 } });

    test("every control 24, 32 or 40px, tiles one size, nothing cut off or past the edge", async ({ page }) => {
      for (const query of ["", "?long", "?servers", "?servers&start=guild", "?empty", "?fail", "?many"]) {
        await open(page, `${query}${query ? "&" : "?"}w=${width}`);
        await expect(page.locator(".nx-tile, .nx-media-empty, .nx-media-line[data-problem]").first()).toBeVisible();
        expect(await misSized(page), query).toEqual([]);
        expect(await clipped(page), query).toEqual([]);
        const sizes = await page.locator(".nx-tile").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((box) => `${Math.round(box.width)}x${Math.round(box.height)}`));
        expect(new Set(sizes).size, `${query}: ${[...new Set(sizes)].join(" ")}`).toBeLessThanOrEqual(1);
        expect(await page.locator("[data-screen='media']").evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1), query).toBe(true);
      }
    });

    test("a tile's buttons sit on its name line, and the name gives them room", async ({ page }) => {
      for (const query of ["", "?servers"]) {
        await open(page, `${query}${query ? "&" : "?"}w=${width}`);
        await expect(page.locator(".nx-tile").first()).toBeVisible();
        const rain = tile(page, "rain-sounds.mp3");
        const title = await rain.locator(".nx-tile-title").boundingBox();
        const buttons = await rain.locator(".nx-tile-actions button").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((box) => ({ top: box.top, bottom: box.bottom, left: box.left })));
        expect(buttons).toHaveLength(2);
        for (const button of buttons) {
          expect(Math.abs(button.top - (title?.y ?? 0)), query).toBeLessThan(1);
          expect(Math.abs(button.bottom - ((title?.y ?? 0) + (title?.height ?? 0))), query).toBeLessThan(1);
        }
        // The name's words end before the first button starts.
        const textEnd = await rain.locator(".nx-tile-title").evaluate((node) => {
          const box = node.getBoundingClientRect();
          return box.right - Number.parseFloat(getComputedStyle(node).paddingRight);
        });
        expect(textEnd, query).toBeLessThanOrEqual(Math.min(...buttons.map((button) => button.left)) + 0.5);
      }
    });

    test("the filters and the grid start on one edge", async ({ page }) => {
      await open(page, `?w=${width}`);
      await expect(page.locator(".nx-tile").first()).toBeVisible();
      const x = async (selector: string) => (await page.locator(selector).first().boundingBox())?.x ?? -1;
      const kinds = await x(".nx-media-kinds");
      expect(Math.abs((await x(".nx-media-narrow")) - kinds)).toBeLessThan(1);
      expect(Math.abs((await x(".nx-media-line")) - kinds)).toBeLessThan(1);
      expect(Math.abs((await x(".nx-tile-face")) - kinds)).toBeLessThan(1);
    });
  });
}
