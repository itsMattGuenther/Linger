import { expect, type Locator, type Page, test } from "@playwright/test";

// The buddy list window on the prototype's Friday evening
// (tests/fixtures/next-list.tsx). What it shows, that it is built the way
// docs/design/system.md says, and that it can be used without a mouse.

test.use({ viewport: { width: 340, height: 820 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html");
  await page.evaluate(() => document.fonts.ready);
});

async function boxes(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
}

function rows(page: Page, list: string): Locator {
  return page.getByRole("list", { name: list }).locator(":scope > li");
}

test("shows the server, you, and the rooms in their order", async ({ page }) => {
  await expect(page.locator(".k-titlebar")).toContainText("The Good Company");
  const you = page.getByRole("region", { name: "You" });
  await expect(you).toContainText("Matt");
  await expect(you).toContainText("in #general");
  await expect(you).toContainText("fixing the porch light (the real one)");
  await expect(rows(page, "Rooms")).toHaveText([/general/, /listening-room/, /weekend-plans/]);
});

test("makes a room bold only when it holds something new, and never shows a number", async ({ page }) => {
  const weights = await rows(page, "Rooms").evaluateAll((items) =>
    items.map((item) => {
      const title = item.querySelector(".k-row-title");
      return title ? Number(getComputedStyle(title).fontWeight) : 0;
    }),
  );
  const [general, listening, plans] = weights;
  expect(general).toBeLessThan(600);
  expect(listening).toBeGreaterThanOrEqual(600);
  expect(plans).toBeGreaterThanOrEqual(600);
  // Nothing in the list is a bare number: no counts, anywhere (AGENTS rule 3).
  const numeric = await page.locator(".nx-list *").evaluateAll((elements) =>
    elements.filter((element) => element.children.length === 0 && /^\s*\d+\s*$/.test(element.textContent ?? "")).length,
  );
  expect(numeric).toBe(0);
});

test("draws every room's # the same, fresh or not", async ({ page }) => {
  const colors = await page.locator(".nx-list [data-kit='HashMark'], .nx-list .k-hash").evaluateAll((marks) =>
    marks.map((mark) => getComputedStyle(mark).color),
  );
  expect(colors.length).toBe(3);
  expect(new Set(colors).size).toBe(1);
});

test("lists DMs by who is in them, with the new one first", async ({ page }) => {
  await expect(rows(page, "DMs")).toHaveText([/Jules/, /Eli and Sam/]);
});

test("groups people into here, away and a folded offline", async ({ page }) => {
  await expect(rows(page, "People here")).toHaveText([/Dave.*in #listening-room/, /Eli.*in #general/, /Jules.*in #general/, /Callie.*around/]);
  await expect(rows(page, "Away")).toHaveText([/Sam.*back after work/]);
  await expect(page.getByRole("list", { name: "Offline" })).toHaveCount(0);
  await page.getByRole("button", { name: /Offline/ }).click();
  await expect(rows(page, "Offline")).toHaveText([/Jen.*last here 1d/]);
});

test("keeps every row of a kind the same height, whatever the name's face", async ({ page }) => {
  await page.getByRole("button", { name: /Offline/ }).click();
  const one = [...(await boxes(rows(page, "Rooms"))), ...(await boxes(rows(page, "DMs")))].map((box) => box.height);
  const two = [
    ...(await boxes(rows(page, "People here"))),
    ...(await boxes(rows(page, "Away"))),
    ...(await boxes(rows(page, "Offline"))),
  ].map((box) => box.height);
  expect(new Set(one)).toEqual(new Set([32]));
  expect(new Set(two)).toEqual(new Set([48]));
});

test("starts every name at the same place, whatever leads the row", async ({ page }) => {
  const starts = await page
    .locator(".nx-list-scroll .k-row-title")
    .evaluateAll((titles) => titles.map((title) => Math.round(title.getBoundingClientRect().x)));
  expect(starts.length).toBeGreaterThan(8);
  expect(new Set(starts).size).toBe(1);
});

test("opens a room, a DM or a person by click and by keyboard", async ({ page }) => {
  await rows(page, "Rooms").first().getByRole("button").first().click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general");
  await rows(page, "DMs").first().getByRole("button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general,dm:d-jules");
  await rows(page, "Away").first().getByRole("button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-opened", /person:u-sam$/);
});

test("says in words what the markers show", async ({ page }) => {
  await expect(page.getByRole("button", { name: "#general, 3 people in it, voice on" })).toBeVisible();
  await expect(page.getByRole("button", { name: "#listening-room, one person in it" })).toBeVisible();
});

test.describe("in voice", () => {
  test("the voice bar names the room, lights who is talking, and offers the three controls", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await expect(bar).toContainText("In voice");
    await expect(bar.getByRole("list", { name: "Who's in voice" }).locator("li")).toHaveText(["you", "Eli", "Jules"]);
    const lit = await bar.locator("[data-kit='Chip']").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-active")));
    expect(lit).toEqual([null, "yes", null]);
    for (const name of ["Mute", "Deafen", "Leave"]) await expect(bar.getByRole("button", { name })).toBeVisible();
    const heights = await bar.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([24]));
  });

  test("its controls do what they say", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await bar.getByRole("button", { name: "Mute" }).click();
    await bar.getByRole("button", { name: "Deafen" }).click();
    await bar.getByRole("button", { name: "Leave" }).click();
    await bar.getByRole("button", { name: "Go to #general" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "mute:true,deafen:true,leave,go:r-general");
  });

  test("with push-to-talk there is no Mute button, and it says how to talk", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&ptt");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await expect(bar.getByRole("button", { name: /^Mute/ })).toHaveCount(0);
    await expect(bar.getByRole("status")).toHaveText("hold control to talk");
  });

  test("the list scrolls above the bar and nothing is hidden under it", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const scroll = await page.locator(".nx-list-scroll").boundingBox();
    const bar = await page.getByRole("region", { name: "In voice in #general" }).boundingBox();
    expect(scroll && bar && scroll.y + scroll.height <= bar.y + 0.5).toBe(true);
  });
});
