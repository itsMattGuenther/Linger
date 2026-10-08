import { expect, type Page, test } from "@playwright/test";

// A room's message of the day (#464, SPEC §4.1), in the real list window with
// a conversation beside it (tests/fixtures/next-list-window.tsx): a strip
// under the room's header, folded to a line on this device until a new one
// is set; `/motd` in the room's box, for the host or a co-host; and the line
// in the room saying who set it. `?motd` has Eli's set in #general.

test.use({ viewport: { width: 1120, height: 820 } });

const HOME = "https://good-company.example";
const ELIS = "Raid night Friday at 8.";
const MEETING = "We will be meeting on Friday, Oct 9 @ 8PM CDT to discuss faction choice. If available, please plan to attend.";

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html?one${query}`);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  // Both of development's connections have their `ready` (next-side.spec.ts).
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const room = (page: Page, name: string) => page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: new RegExp(`^#${name}\\b`) });
const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const strip = (page: Page) => page.getByRole("note", { name: "Message of the day" });
const fold = (page: Page) => page.getByRole("button", { name: "Fold the message of the day to one line" });
const unfold = (page: Page) => page.getByRole("button", { name: "Show the whole message of the day" });

async function openGeneral(page: Page) {
  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

test("shows whole under the room's header, beside the topic, with who set it", async ({ page }) => {
  await open(page, "&motd");
  await openGeneral(page);
  await expect(strip(page)).toContainText(ELIS);
  // When it was set reads as a sentence's end (lib/time.ts `setWhen`, tested there).
  await expect(strip(page)).toContainText("Message of the day, set by Eli on September 25");
  // A mention in it reads as the name, as in a message.
  await expect(strip(page)).toContainText("Matt brings the snacks");
  // The topic says what the room is about, and stays where it was.
  await expect(page.locator(".nx-pane-head")).toContainText("Good company. No hurry.");
  // Under the header, over the conversation.
  const head = await page.locator(".nx-pane-head").boundingBox();
  const note = await strip(page).boundingBox();
  const log = await page.getByRole("log").boundingBox();
  expect(note && head && note.y >= head.y + head.height - 1).toBe(true);
  expect(note && log && note.y + note.height <= log.y + 1).toBe(true);
});

test("folds to one line, and stays folded after the app is closed and opened again", async ({ page }) => {
  await open(page, "&motd");
  await openGeneral(page);
  const open_ = (await strip(page).boundingBox())?.height ?? 0;
  await fold(page).click();
  await expect(unfold(page)).toBeVisible();
  await expect(strip(page)).toContainText(ELIS);
  await expect(strip(page)).not.toContainText("set by");
  const folded = (await strip(page).boundingBox())?.height ?? 0;
  expect(folded).toBeLessThan(open_);
  expect(folded).toBeLessThanOrEqual(36);

  // Closed and opened again: still folded. (The strip is the room's, so it
  // doesn't wait on the history a reopened tab loads.)
  await open(page, "&motd");
  await room(page, "general").click();
  await expect(strip(page)).toContainText(ELIS);
  await expect(unfold(page)).toBeVisible();
  await expect(strip(page)).not.toContainText("set by");

  // And opens again when asked.
  await unfold(page).click();
  await expect(strip(page)).toContainText("set by Eli");
  await expect(fold(page)).toBeVisible();
});

test("a new message of the day opens again for everybody who folded the last", async ({ page }) => {
  await open(page, "&motd");
  await openGeneral(page);
  await fold(page).click();
  await expect(unfold(page)).toBeVisible();
  await page.evaluate(
    ([server, text]) =>
      window.core?.frame(server, {
        op: "room.update",
        d: {
          id: "r-general",
          slug: "general",
          name: "general",
          topic: "Good company. No hurry.",
          kind: "room",
          member_ids: null,
          position: 0,
          archived_at: null,
          last_message_id: "m000016",
          motd: { text, set_by: "u-eli", set_at: Date.now() },
        },
      } as never),
    [HOME, MEETING] as const,
  );
  await expect(strip(page)).toContainText(MEETING);
  await expect(fold(page)).toBeVisible();
});

test("/motd in a room's box sets it for everybody: a line in the room, not a message", async ({ page }) => {
  await open(page, "");
  await openGeneral(page);
  await expect(strip(page)).toHaveCount(0);

  await box(page).fill("/mo");
  await expect(page.locator(".nx-composer-command")).toContainText("/motd");
  await expect(page.locator(".nx-composer-command")).toContainText("Sets #general's message of the day");
  await box(page).fill(`/motd ${MEETING}`);
  await box(page).press("Enter");

  await expect(box(page)).toHaveValue("");
  await expect(strip(page)).toContainText(MEETING);
  await expect(strip(page)).toContainText("set by Matt");
  const line = page.locator(".nx-msg[data-motd='yes']");
  await expect(line).toContainText("set the message of the day");
  await expect(line).toContainText(MEETING);
  // A line of its own, quoted, and no Edit among its actions.
  await line.hover();
  await line.getByRole("button", { name: /^Actions for/ }).click();
  await expect(page.getByRole("menuitem", { name: "Reply" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const asked = await did(page);
  expect(asked).toContain(`room r-general ${JSON.stringify({ name: null, topic: null, position: null, motd: MEETING })}`);
  // Setting it isn't typing.
  expect(asked.some((one) => one.includes('"op":"typing.start"'))).toBe(false);
  // Nothing went out as a message saying "/motd".
  await expect(page.getByRole("log")).not.toContainText("/motd");
});

test("/motd on its own clears it", async ({ page }) => {
  await open(page, "&motd");
  await openGeneral(page);
  await expect(strip(page)).toBeVisible();
  await box(page).fill("/motd");
  await box(page).press("Enter");
  await expect(strip(page)).toHaveCount(0);
  expect(await did(page)).toContain(`room r-general ${JSON.stringify({ name: null, topic: null, position: null, motd: "" })}`);
});

test("only the host or a co-host can: anybody else's box says so and keeps the words", async ({ page }) => {
  await open(page, "&guest");
  await openGeneral(page);
  await box(page).fill("/motd my own news");
  await expect(page.locator(".nx-composer-command")).toContainText("Only the host or a co-host can set the message of the day.");
  await box(page).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Only the host or a co-host can set the message of the day.");
  await expect(box(page)).toHaveValue("/motd my own news");
  expect((await did(page)).some((one) => one.startsWith("room "))).toBe(false);
});

test("a co-host can", async ({ page }) => {
  await open(page, "&cohost");
  await openGeneral(page);
  await box(page).fill(`/motd ${MEETING}`);
  await box(page).press("Enter");
  await expect(strip(page)).toContainText(MEETING);
});

test("a new message of the day doesn't make its room look new", async ({ page }) => {
  await open(page, "");
  await room(page, "listening-room").click();
  await expect(page.getByRole("log")).toContainText("Village Vanguard");
  const weight = () =>
    room(page, "general")
      .locator(".k-row-title")
      .evaluate((title) => Number(getComputedStyle(title).fontWeight));
  expect(await weight()).toBeLessThan(600);

  const line = (id: string, motd: boolean) => ({
    id,
    room_id: "r-general",
    author_id: "u-eli",
    body: MEETING,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: Date.now(),
    ...(motd ? { motd: true } : {}),
  });
  await page.evaluate(([server, d]) => window.core?.frame(server, { op: "message.create", d } as never), [HOME, line("m900100", true)] as const);
  // Give it the chance to be wrong.
  await page.waitForTimeout(200);
  expect(await weight()).toBeLessThan(600);
  // An ordinary message still does.
  await page.evaluate(([server, d]) => window.core?.frame(server, { op: "message.create", d } as never), [HOME, line("m900101", false)] as const);
  await expect.poll(weight).toBeGreaterThanOrEqual(600);
});

test.describe("on the phone", () => {
  test.use({ viewport: { width: 412, height: 880 }, hasTouch: true, isMobile: true });

  test("the strip sits under the title bar and folds the same way", async ({ page }) => {
    await open(page, "&motd&shell=phone");
    await room(page, "general").click();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    await expect(strip(page)).toContainText(ELIS);
    const title = await page.locator("[data-screen='chat'] .k-titlebar").boundingBox();
    const note = await strip(page).boundingBox();
    expect(note && title && note.y >= title.y + title.height - 1).toBe(true);
    await fold(page).tap();
    await expect(unfold(page)).toBeVisible();
  });
});
