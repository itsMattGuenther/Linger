import { expect, type Locator, type Page, test } from "@playwright/test";

// Somebody joining voice (#473, SPEC §4.14): a quiet grey line in the room or
// DM, the names grey too; joins with nothing said between them share one
// line; past four people the rest are dots, and past sixteen dots the people
// mark lists everybody. The chat window on the prototype's evening
// (tests/fixtures/next-chat.tsx), `?joins`: Jules joins #general and says
// something, then Dave and Callie join together; Jules joins the DM too.
// `?raid` adds twenty-five raiders to Dave and Callie's line.

test.use({ viewport: { width: 780, height: 790 } });

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-chat.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("log")).toBeVisible();
  await expect(page.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
}

const lines = (page: Page) => page.locator("[data-join]");
const line = (page: Page, words: string | RegExp) => page.locator("[data-join]", { hasText: words });

/** A token's color, as the engine paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

async function color(locator: Locator): Promise<string> {
  return locator.evaluate((node) => getComputedStyle(node).color);
}

test("a join is one quiet grey line, its name grey too, and whoever speaks next is named", async ({ page }) => {
  await open(page, "?joins");
  const jules = line(page, "Jules joined voice");
  await expect(jules).toBeVisible();
  // All grey: the words and the name in the dimmest text there is.
  const muted = await token(page, "--text-muted");
  expect(await color(jules.locator(".nx-quiet-words"))).toBe(muted);
  expect(await color(jules.locator("[data-kit='Name']"))).toBe(await token(page, "--text-offline"));
  // Its time shows without hovering, as a group's first line's does.
  await expect(jules.locator("time")).toBeVisible();
  await expect(jules.locator("time")).toHaveText("10:50 PM");
  // Nothing to press on it: it isn't replied to, edited or pinned.
  await expect(jules.getByRole("button")).toHaveCount(0);
  // Jules speaking next says who's talking, though the line above was theirs.
  await expect(page.locator(".nx-msg", { hasText: "here! these speakers" }).locator(".nx-msg-who")).toBeVisible();
});

test("its words start where a name starts, on one line", async ({ page }) => {
  await open(page, "?joins");
  const words = await line(page, "Jules joined voice").locator(".nx-quiet-words").boundingBox();
  const name = await page.locator(".nx-msg", { hasText: "here! these speakers" }).locator(".nx-msg-who").boundingBox();
  expect(words && name && Math.abs(words.x - name.x)).toBeLessThanOrEqual(1);
  expect(words?.height).toBeLessThanOrEqual(24);
});

test("joins with nothing said between them share a line", async ({ page }) => {
  await open(page, "?joins");
  await expect(lines(page)).toHaveCount(2);
  await expect(lines(page).nth(1).locator(".nx-quiet-words")).toHaveText("Dave and Callie joined voice");
});

test("a DM gets the same line", async ({ page }) => {
  await open(page, "?joins&tab=d-jules");
  await expect(line(page, "Jules joined voice")).toBeVisible();
});

test("on raid night: three names, sixteen dots, and the people mark lists everybody", async ({ page }) => {
  await open(page, "?joins&raid");
  const crowd = line(page, "Dave, Callie, Kestrel and");
  await expect(crowd).toBeVisible();
  // Everybody past the names is a dot with their name on it; sixteen show.
  await expect(crowd.locator(".nx-join-dot")).toHaveCount(16);
  await expect(crowd.locator(".nx-join-dot").first()).toHaveAttribute("title", "Bramble");
  // Still one line, never "and 24 more".
  await expect(crowd).not.toContainText(/\d+ (more|others)/);
  const words = await crowd.locator(".nx-quiet-words").boundingBox();
  expect(words?.height).toBeLessThanOrEqual(24);

  const mark = crowd.getByRole("button", { name: "Everyone who joined voice" });
  await mark.click();
  const card = page.getByRole("dialog", { name: "Everyone who joined voice" });
  await expect(card).toBeVisible();
  // Dave, Callie and the twenty-five raiders, by name, in the order they joined.
  await expect(card.getByRole("listitem")).toHaveCount(27);
  await expect(card.getByRole("listitem").first()).toContainText("Dave");
  // Over what opened it, and inside the window.
  const box = await card.boundingBox();
  const opener = await mark.boundingBox();
  expect(box && opener && box.y + box.height).toBeLessThanOrEqual((opener?.y ?? 0) + 1);
  expect(box && box.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});
