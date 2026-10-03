import { expect, type Page, test } from "@playwright/test";

// Report and block (SPEC §4.15, PROTOCOL §5, T-1605) on a computer, in the
// real list window (tests/fixtures/next-list-window.tsx) and the real
// Settings window (tests/fixtures/next-settings-window.tsx). The least UI
// that does the job: behind a ··· on a person's card and last in a message's
// actions; a blocked person's messages each a grey line; the host told by
// one lit row, never a count. The phone's are in next-phone.spec.ts.

test.use({ viewport: { width: 1120, height: 820 } });

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The list window with #general beside it, once every connection is in (next-side.spec.ts says why, #355). */
async function inGeneral(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

const card = (page: Page, who: string) => page.getByRole("dialog", { name: who, exact: true });
const more = (page: Page, who: string) => page.getByRole("button", { name: `More for ${who}` });
/** Open somebody's card from their name in the conversation. */
const openCard = (page: Page, who: string) => page.getByRole("log").locator(".nx-msg [data-kit='Name']", { hasText: who }).first().click();
const greyLines = (page: Page) => page.getByRole("log").getByText("From Jules, who you blocked");

/** A message's actions, from its ··· (hovered into view, as with a mouse). */
async function actionsFor(page: Page, words: string) {
  const row = page.locator(".nx-msg", { hasText: words }).last();
  await row.hover();
  await row.getByRole("button", { name: /^Actions for/ }).click();
  return page.getByRole("menu");
}

test.describe("on a person's card", () => {
  test("··· offers Report and Block; a report goes to the host with a note, and says so", async ({ page }) => {
    await inGeneral(page, "?one&guest");
    await openCard(page, "Jules");
    await more(page, "Jules").click();
    const menu = page.getByRole("menu", { name: "More for Jules" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Report Jules…", "Block Jules"]);

    await menu.getByRole("menuitem", { name: "Report Jules…" }).click();
    // The menu goes with the card's view: it doesn't come back over the form.
    await expect(menu).toHaveCount(0);
    const form = page.getByRole("form", { name: "Report Jules" });
    await expect(form).toContainText("It goes to Eli, who hosts this server, and to nobody else. Jules isn't told.");
    await form.getByRole("textbox", { name: "A note for Eli, if you like" }).fill("Just letting you know.");
    await form.getByRole("button", { name: "Send to Eli" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent to Eli" })).toHaveText("Sent to Eli. Only Eli sees it.Done");
    expect((await did(page)).filter((line) => line.startsWith("report "))).toEqual([`report ${JSON.stringify({ user_id: "u-jules", note: "Just letting you know." })}`]);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(more(page, "Jules")).toBeVisible();
  });

  test("Block asks first, then folds their messages into grey lines that open; Unblock undoes it", async ({ page }) => {
    await inGeneral(page, "?one&guest");
    // Their message itself, not a reply quoting it.
    const theirs = page.getByRole("log").locator(".nx-msg-body", { hasText: "Anyone around for a little while?" });
    await expect(theirs).toHaveCount(1);
    await openCard(page, "Jules");
    await more(page, "Jules").click();
    await page.getByRole("menuitem", { name: "Block Jules" }).click();
    const ask = page.getByRole("group", { name: "Block Jules" });
    await expect(ask).toContainText("Jules isn't told");
    // Cancel is first, so a stray Enter doesn't block anybody.
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    await ask.getByRole("button", { name: "Block Jules" }).click();

    await expect(card(page, "Jules")).toContainText("You've blocked Jules. Their messages fold away for you.");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await did(page)).toContain("block u-jules");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Every message of theirs is one grey line, and Show opens it.
    await expect(greyLines(page).first()).toBeVisible();
    await expect(theirs).toHaveCount(0);
    await page.getByRole("log").getByRole("button", { name: /^A message from Jules, who you blocked/ }).first().click();
    await expect(page.getByRole("log").locator(".nx-msg [data-kit='Name']", { hasText: "Jules" }).first()).toBeVisible();

    await openCard(page, "Jules");
    await more(page, "Jules").click();
    await page.getByRole("menuitem", { name: "Unblock Jules" }).click();
    await expect.poll(async () => did(page)).toContain("unblock u-jules");
    await expect(greyLines(page)).toHaveCount(0);
  });

  test("the host has nobody to report to: the card offers Block only", async ({ page }) => {
    await inGeneral(page, "?one");
    await openCard(page, "Jules");
    await more(page, "Jules").click();
    await expect(page.getByRole("menu", { name: "More for Jules" }).getByRole("menuitem")).toHaveText(["Block Jules"]);
  });
});

test.describe("on a message", () => {
  test("Report to host… is last in its actions, and its form opens by the message, inside the window", async ({ page }) => {
    await inGeneral(page, "?one&guest");
    const menu = await actionsFor(page, "No plans, no agenda");
    await expect(menu.getByRole("menuitem").last()).toHaveText("Report to host…");
    await menu.getByRole("menuitem", { name: "Report to host…" }).click();

    const form = page.getByRole("form", { name: "Report Eli's message" });
    await expect(form).toContainText("No plans, no agenda. I can get behind that.");
    // Inside the window: a row is moved into place with a transform, and the
    // form once drew from the row instead of the window, off the side.
    const box = await form.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 1120).toBe(true);
    expect((box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= 820).toBe(true);

    await form.getByRole("button", { name: "Send to Eli" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent to Eli" })).toBeVisible();
    const sent = (await did(page)).find((line) => line.startsWith("report "));
    expect(JSON.parse(sent?.slice("report ".length) ?? "{}")).toMatchObject({ message_id: expect.any(String) });
    expect(sent).not.toContain("note");
  });

  test("your own messages have no Report", async ({ page }) => {
    await inGeneral(page, "?one&guest");
    const mine = await actionsFor(page, "Count me in.");
    await expect(mine.getByRole("menuitem").first()).toBeVisible();
    await expect(mine.getByRole("menuitem", { name: "Report to host…" })).toHaveCount(0);
  });

  test("the host has nobody to report a message to", async ({ page }) => {
    await inGeneral(page, "?one");
    const theirs = await actionsFor(page, "No plans, no agenda");
    await expect(theirs.getByRole("menuitem").first()).toBeVisible();
    await expect(theirs.getByRole("menuitem", { name: "Report to host…" })).toHaveCount(0);
  });
});

test.describe("what a block hides", () => {
  test("Media leaves out what a blocked person shared", async ({ page }) => {
    await inGeneral(page, "?one&blocked");
    await page.getByRole("button", { name: "Media", exact: true }).click();
    const media = page.locator("[data-screen='media']");
    await expect(media).toBeVisible();
    await expect(media.getByText("speakers.png")).toHaveCount(0);
    await expect(media.locator("[data-kit='Name']", { hasText: "Eli" }).first()).toBeVisible();
  });

  test("Search leaves them out too: the same words find Jules until Jules is blocked", async ({ page }) => {
    const search = async (query: string) => {
      await inGeneral(page, query);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("textbox", { name: "Search", exact: true }).fill("speakers");
    };
    const jules = page.locator("[data-screen='search'] [data-kit='Name']", { hasText: "Jules" });
    await search("?one");
    await expect(jules.first()).toBeVisible();
    await page.evaluate(() => localStorage.clear());
    // Blocked, the answer comes back and has nothing left to show.
    await search("?one&blocked");
    await expect(page.locator("[data-screen='search']").getByText("Nothing here matches that.")).toBeVisible();
    await expect(jules).toHaveCount(0);
  });
});

test.describe("for the host", () => {
  test("one lit row says there's a report, from the moment the list opens, and leads to People", async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 820 });
    await page.goto("/tests/fixtures/next-list-window.html?one&reports");
    const row = page.getByRole("button", { name: /A report to look at/ });
    await expect(row).toBeVisible();
    // No number anywhere (AGENTS rule 3).
    await expect(row).not.toHaveText(/\d/);
    await row.click();
    await expect.poll(async () => (await did(page)).find((line) => line.startsWith("next_open_settings"))).toContain("people");
  });

  test("People shows each report, who sent it and what it's about, and Let it go and Delete close it", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/tests/fixtures/next-settings-window.html?section=people&reports");
    const reports = page.getByRole("list", { name: "Reports" });
    const report = reports.getByRole("listitem");
    await expect(report).toContainText("From Eli, about a message by Jules in #general");
    await expect(report).toContainText("Anyone around for a little while?");
    await expect(report).toContainText('"This felt a bit much tonight."');
    await report.getByRole("button", { name: "Let it go" }).click();
    await expect.poll(async () => did(page)).toContain("close r-1");
    await expect(reports).toHaveCount(0);

    await page.goto("/tests/fixtures/next-settings-window.html?section=people&reports");
    await page.getByRole("list", { name: "Reports" }).getByRole("button", { name: "Delete message" }).click();
    await expect.poll(async () => (await did(page)).filter((line) => /^(delete|close) /.test(line))).toEqual([expect.stringMatching(/^delete m\d+/), "close r-1"]);
  });

  test("Account lists who you've blocked, to unblock", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/tests/fixtures/next-settings-window.html?section=account&blocked");
    const blocked = page.getByRole("region", { name: /Blocked/i });
    await expect(blocked).toContainText("@jules");
    await blocked.getByRole("button", { name: /Unblock/ }).click();
    await expect.poll(async () => did(page)).toContain("unblock u-jules");
    await expect(blocked).toHaveCount(0);
  });
});
