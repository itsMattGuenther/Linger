import { expect, type Page, test } from "@playwright/test";

// Search in the new client (tests/fixtures/next-search.tsx), measured against
// docs/design/system.md and driven like a person would: the box, the pause
// before asking, the filters, the hits and their keyboard, the states, and
// several servers. The words themselves are unit-tested in
// src/next/core/search.test.ts.

const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";
/** `TYPING_PAUSE_MS` in lib/search.ts, and a margin. */
const PAUSE = 320;

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-search.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='search']")).toBeVisible();
  await expect(page.locator("body[data-ready='yes']")).toBeAttached();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|").filter((line) => line !== "");
}

async function searches(page: Page): Promise<string[]> {
  return (await did(page)).filter((line) => line.startsWith("search "));
}

const box = (page: Page) => page.getByRole("textbox", { name: "Search", exact: true });
const hits = (page: Page) => page.locator(".nx-hit-main");
const status = (page: Page) => page.locator(".nx-find-status");

/** Search for these words and wait for the answer. */
async function find(page: Page, words: string) {
  const before = (await searches(page)).length;
  await box(page).fill(words);
  await expect.poll(async () => (await searches(page)).length).toBeGreaterThan(before);
  await expect(status(page)).toHaveText("");
}

test.describe("the box", () => {
  test.use({ viewport: { width: 520, height: 640 } });

  test("has the cursor when it opens, and Ctrl+K from the host puts it back with the words selected", async ({ page }) => {
    await open(page);
    await expect(box(page)).toBeFocused();
    await box(page).fill("porch");
    await page.getByRole("combobox", { name: "Where" }).focus();
    await page.keyboard.press("Control+k");
    await expect(box(page)).toBeFocused();
    expect(await box(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 5]);
    // The host owns the shortcut: the pane only answered its request.
    expect(await did(page)).toContain("ctrl+k");
  });

  test("asks once after a pause in typing, and never for a box with no word in it", async ({ page }) => {
    await open(page);
    await page.keyboard.type("?!", { delay: 20 });
    await page.waitForTimeout(PAUSE * 2);
    expect(await searches(page)).toEqual([]);
    await expect(page.locator(".nx-find-empty")).toHaveText("Type a word to search for.");

    await box(page).fill("");
    await expect(page.locator(".nx-find-empty")).toHaveText("Search what people have said here, and the names of the files they shared.");
    await page.keyboard.type("porch", { delay: 40 });
    await expect(hits(page)).toHaveCount(5);
    await page.waitForTimeout(PAUSE * 2);
    expect(await searches(page)).toEqual(["search q=porch room= author= before="]);
  });

  test("asks at once on Enter, and only once", async ({ page }) => {
    await open(page, "?slow");
    await page.keyboard.type("porch");
    await page.keyboard.press("Enter");
    // Well before the pause is over, it has asked.
    expect(await searches(page)).toEqual(["search q=porch room= author= before="]);
    await page.waitForTimeout(PAUSE * 2);
    expect(await searches(page)).toHaveLength(1);
  });

  test("stops at 200 characters", async ({ page }) => {
    await open(page);
    await box(page).fill("porch ".repeat(50));
    expect(await box(page).inputValue()).toHaveLength(200);
  });

  test("drops a slower answer to an older search", async ({ page }) => {
    await open(page, "?slow");
    await page.keyboard.type("porch");
    await expect.poll(() => searches(page)).toHaveLength(1);
    // Watch for porch ever being marked from here on: its answer lands a
    // second after it was asked, while moon's is still out, and must not show.
    await page.evaluate(() => {
      const seen = { porch: false };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver(() => {
        if ([...document.querySelectorAll(".nx-hit mark")].some((mark) => /porch/i.test(mark.textContent ?? ""))) seen.porch = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await box(page).fill("moon");
    await expect.poll(() => searches(page)).toHaveLength(2);
    await expect(hits(page).first()).toHaveAttribute("aria-label", /moon/, { timeout: 4000 });
    expect(await page.evaluate(() => (window as unknown as { seen: { porch: boolean } }).seen.porch)).toBe(false);
  });
});

test.describe("hits", () => {
  test.use({ viewport: { width: 520, height: 640 } });

  test("say who, where and when, newest first, with the matched words marked", async ({ page }) => {
    await open(page);
    await find(page, "porch");
    await expect(hits(page)).toHaveCount(5);
    const labels = await hits(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
    expect(labels.map((label) => label.split(",")[0])).toEqual([
      "Jules in a DM with Jules",
      "Sam in #general",
      "Callie in #general",
      "Sam in #general",
      "Sam in a DM with Eli and Sam",
    ]);
    // One sentence each, with the whole date and the words.
    expect(labels[0]).toMatch(/^Jules in a DM with Jules, .*2026.*: did you ever fix the actual porch light$/);
    for (const text of await page.locator(".nx-hit mark").allTextContents()) expect(text.toLowerCase()).toBe("porch");
    await expect(page.locator(".nx-hit mark")).toHaveCount(5);
    // What's drawn is for the eye; the sentence is what a screen reader hears.
    await expect(page.locator(".nx-hit-text").first()).toHaveAttribute("aria-hidden", "true");
    // A DM is named by its people, with a mark that says it's a DM.
    await expect(page.locator(".nx-hit").first().locator(".nx-hit-where")).toHaveText("Jules");
    await expect(page.locator(".nx-hit").first().locator(".nx-hit-dm")).toHaveCount(1);
    await expect(page.locator(".nx-hit").nth(1).locator(".nx-hit-dm")).toHaveCount(0);
  });

  test("found by a file's name say which file", async ({ page }) => {
    await open(page);
    await find(page, "speakers");
    await expect(hits(page)).toHaveCount(2);
    const byFile = page.locator(".nx-hit", { has: page.locator(".nx-hit-file") });
    await expect(byFile).toHaveCount(1);
    await expect(byFile.locator("mark")).toHaveText("speakers.png");
    await expect(byFile.locator(".nx-hit-also")).toHaveText("exhibit a");
    await expect(byFile.locator(".nx-hit-main")).toHaveAttribute("aria-label", /: exhibit a, and the file speakers\.png$/);
  });

  test("open their message on the server they came from", async ({ page }) => {
    await open(page);
    await find(page, "porch");
    await hits(page).nth(1).click();
    expect(await did(page)).toContain("open r-general m000003");
  });

  test("from an archived room show, but can't open", async ({ page }) => {
    await open(page, "?archived");
    await find(page, "trailhead");
    await expect(hits(page)).toHaveCount(1);
    await expect(hits(page).first()).toBeDisabled();
    await expect(hits(page).first()).toHaveAttribute("aria-label", /^Sam in an archived room, /);
    await expect(page.locator(".nx-hit-where")).toHaveText("archived room");
  });

  test("filter by room and by person, together", async ({ page }) => {
    await open(page);
    await find(page, "porch");
    const where = page.getByRole("combobox", { name: "Where" });
    const who = page.getByRole("combobox", { name: "Who" });
    // The rooms in the list's order, then DMs by who's in them, never by id.
    expect(await where.locator("option").allTextContents()).toEqual(["Anywhere", "#general", "#listening-room", "#weekend-plans", "Eli and Sam", "Jules"]);
    await where.selectOption({ label: "#general" });
    await expect(hits(page)).toHaveCount(3);
    await who.selectOption({ label: "Sam" });
    await expect(hits(page)).toHaveCount(2);
    expect((await searches(page)).at(-1)).toBe("search q=porch room=r-general author=u-sam before=");
    await who.selectOption({ label: "Eli" });
    await expect(page.locator(".nx-find-empty")).toHaveText("Nothing matches that in the room or from the person you picked.");
  });

  test("move with the arrows from the box, one in the tab order, and open with Enter", async ({ page }) => {
    await open(page);
    await find(page, "porch");
    await expect(hits(page)).toHaveCount(5);
    await expect(page.locator(".nx-hit-main[tabindex='0']")).toHaveCount(1);
    await box(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(hits(page).nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(hits(page).nth(2)).toBeFocused();
    await page.keyboard.press("End");
    await expect(hits(page).nth(4)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(hits(page).nth(4)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(hits(page).nth(0)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(box(page)).toBeFocused();
    // Back in, the list remembers where you were.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".nx-hit-main[tabindex='0']")).toHaveCount(1);
    await expect(hits(page).nth(1)).toHaveAttribute("tabindex", "0");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(hits(page).nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await did(page)).toContain("open r-general m000003");
  });
});

test.describe("states", () => {
  test.use({ viewport: { width: 520, height: 640 } });

  test("says it's searching until the answer comes", async ({ page }) => {
    await open(page, "?slow");
    await page.keyboard.type("porch");
    await expect(status(page)).toHaveText("Searching…");
    await expect(hits(page)).toHaveCount(5);
    await expect(status(page)).toHaveText("");
  });

  test("says when nothing matched", async ({ page }) => {
    await open(page);
    await find(page, "zebra");
    await expect(page.locator(".nx-find-empty")).toHaveText("Nothing here matches that.");
    await expect(hits(page)).toHaveCount(0);
  });

  test("says what went wrong, in the server's words", async ({ page }) => {
    await open(page, "?fail");
    await box(page).fill("porch");
    await expect(status(page)).toHaveText("Slow down: that's thirty searches this minute.");
    await expect(status(page)).toHaveAttribute("data-problem", "");
    await expect(status(page)).toHaveAttribute("role", "status");
    // A refusal isn't "nothing matched".
    await expect(page.locator(".nx-find-empty")).toHaveCount(0);
  });

  test("a refused search keeps what was showing", async ({ page }) => {
    await open(page, "?failsecond");
    await find(page, "porch");
    await expect(hits(page)).toHaveCount(5);
    await box(page).fill("moon");
    await expect(status(page)).toHaveText("Slow down: that's thirty searches this minute.");
    await expect(hits(page)).toHaveCount(5);
    await expect(page.locator(".nx-find-empty")).toHaveCount(0);
  });

  test("pages older hits on, asking after the last one", async ({ page }) => {
    await open(page, "?many");
    await find(page, "porch");
    await expect(hits(page)).toHaveCount(25);
    const older = page.getByRole("button", { name: "Show older" });
    await older.click();
    await expect(hits(page)).toHaveCount(50);
    const asked = await searches(page);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/before=m7\d{5}$/);
    await older.click();
    await expect(hits(page)).toHaveCount(65);
    await expect(older).toHaveCount(0);
  });
});

test.describe("several servers", () => {
  test.use({ viewport: { width: 520, height: 640 } });

  test("with one there's nothing to pick", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("combobox", { name: "Server" })).toHaveCount(0);
  });

  test("every server's hits merge newest first, each saying which server it's from", async ({ page }) => {
    await open(page, "?servers");
    const server = page.getByRole("combobox", { name: "Server" });
    await expect(server).toHaveValue("every");
    // Rooms and people are per server: every server has no filters to offer.
    await expect(page.getByRole("combobox", { name: "Where" })).toHaveCount(0);
    await expect(page.locator(".nx-find-filters-off")).toHaveText("Pick one server to look in a room, or for a person.");
    await find(page, "porch");
    await expect(hits(page)).toHaveCount(10);
    const asked = await searches(page);
    expect(asked.sort()).toEqual([`search ${GUILD} q=porch room= author= before=`, `search ${LISBON} q=porch room= author= before=`, "search q=porch room= author= before="].sort());
    const labels = await hits(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
    expect(labels.slice(0, 5).map((label) => label.split(",")[0])).toEqual([
      "Jules in a DM with Jules on The Good Company",
      "Nyx in a DM with Nyx on Ashen Lanterns",
      "Kestrel in #general on Ashen Lanterns",
      "Inês in #geral on Casa da Ribeira",
      "Inês in a DM with Inês on Casa da Ribeira",
    ]);
    // Each hit carries its server's bar where the picker's bars are.
    await expect(page.locator(".nx-hit .nx-scope-mark")).toHaveCount(10);
    const bar = await page.locator(".nx-hit .nx-scope-mark").first().boundingBox();
    const slot = await page.locator(".nx-scope-marks").boundingBox();
    expect(Math.abs((bar?.x ?? 0) + (bar?.width ?? 0) / 2 - ((slot?.x ?? 0) + (slot?.width ?? 0) / 2))).toBeLessThan(1);
    await hits(page).nth(2).click();
    expect(await did(page)).toContain(`open ${GUILD} a-general m000903`);
  });

  test("picking one server asks only it, and brings its filters back", async ({ page }) => {
    await open(page, "?servers");
    await find(page, "porch");
    await page.getByRole("combobox", { name: "Server" }).selectOption({ label: "Ashen Lanterns" });
    await expect.poll(async () => (await searches(page)).at(-1)).toBe(`search ${GUILD} q=porch room= author= before=`);
    await expect(hits(page)).toHaveCount(3);
    await expect(page.locator(".nx-hit .nx-scope-mark")).toHaveCount(0);
    await expect(hits(page).first()).toHaveAttribute("aria-label", /^Nyx in a DM with Nyx, /);
    expect(await page.getByRole("combobox", { name: "Where" }).locator("option").allTextContents()).toEqual(["Anywhere", "#raid-night", "#general", "#loot-council", "#lfg", "Nyx"]);
    // A room on one server means nothing on another: switching lets go of it.
    await page.getByRole("combobox", { name: "Where" }).selectOption({ label: "#general" });
    await page.getByRole("combobox", { name: "Who" }).selectOption({ label: "Kestrel" });
    await expect.poll(async () => (await searches(page)).at(-1)).toBe(`search ${GUILD} q=porch room=a-general author=a-kestrel before=`);
    await page.getByRole("combobox", { name: "Server" }).selectOption({ label: "Casa da Ribeira" });
    await expect.poll(async () => (await searches(page)).at(-1)).toBe(`search ${LISBON} q=porch room= author= before=`);
    await expect(page.getByRole("combobox", { name: "Where" })).toHaveValue("");
    await expect(page.getByRole("combobox", { name: "Who" })).toHaveValue("");
    await expect(hits(page)).toHaveCount(2);
  });

  test("starts on the server it was opened from", async ({ page }) => {
    await open(page, "?servers&start=guild");
    await expect(page.getByRole("combobox", { name: "Server" })).toHaveValue(GUILD);
  });

  test("one server refusing leaves the others' hits, and says which refused", async ({ page }) => {
    await open(page, "?servers&failguild");
    await box(page).fill("porch");
    await expect(status(page)).toHaveText("Ashen Lanterns: Slow down: that's thirty searches this minute.");
    await expect(hits(page)).toHaveCount(7);
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

/** Text cut off without an ellipsis, or running past the pane (kit.spec's rule, over search). */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const pane = document.querySelector("[data-screen='search']");
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

    test("every control 24, 32 or 40px, hits 48px, nothing cut off or past the edge", async ({ page }) => {
      for (const [query, words] of [
        ["", ""],
        ["", "porch"],
        ["?long", "porch"],
        ["?servers", "porch"],
        ["?servers&long", "porch"],
        ["?servers&start=guild", "porch"],
        ["", "speakers"],
        ["?fail", "porch"],
        ["?many", "porch"],
      ] as const) {
        await open(page, `${query}${query ? "&" : "?"}w=${width}`);
        if (words) {
          await box(page).fill(words);
          await expect(page.locator(".nx-hit-main, .nx-find-status[data-problem]").first()).toBeVisible();
        }
        const where = `${query} ${words}`;
        expect(await misSized(page), where).toEqual([]);
        expect(await clipped(page), where).toEqual([]);
        for (const height of await hits(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))) expect(height, where).toBe(48);
        expect(await page.locator("[data-screen='search']").evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1), where).toBe(true);
      }
    });

    test("the words start on the box's edge, and mixed servers' words on the picker's", async ({ page }) => {
      await open(page, `?w=${width}`);
      await find(page, "porch");
      const edge = async (selector: string) => (await page.locator(selector).first().boundingBox())?.x ?? -1;
      const end = async (selector: string) => {
        const found = await page.locator(selector).first().boundingBox();
        return (found?.x ?? 0) + (found?.width ?? 0);
      };
      expect(Math.abs((await edge(".nx-hit-words")) - (await edge(".nx-find-box [data-kit-control]")))).toBeLessThan(1);
      // And run to its other edge.
      expect(Math.abs((await end(".nx-hit-words")) - (await end(".nx-find-box [data-kit-control]")))).toBeLessThan(1);
      await open(page, `?servers&w=${width}`);
      await find(page, "porch");
      expect(Math.abs((await edge(".nx-hit-words")) - (await edge(".nx-scope-pick [data-kit-control]")))).toBeLessThan(1);
      // Narrow, the bar says which server; with room, its name does too.
      if (width < 500) await expect(page.locator(".nx-hit-server").first()).toBeHidden();
      else await expect(page.locator(".nx-hit-server").first()).toHaveText("The Good Company");
    });
  });
}
