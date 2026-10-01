import { expect, type Page, test } from "@playwright/test";

// Conversations beside the list (#337), in the real list window
// (tests/fixtures/next-list-window.tsx): rooms and DMs open as tabs in the
// list's own window, which unfolds to show them and folds back to just the
// list. The window's size is faked in the page and every resize is written
// down; the page itself is the size a test gives it, so a test that wants
// the conversation beside the list gives it the room (`grown`).
// A conversation in a window of its own is next-chat-window.spec.ts's.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";

async function open(page: Page, query = "?one") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await settled(page);
}

/**
 * Every connection the page opened has had its `ready`. In development React
 * starts the list twice, so each server is connected twice, and a `ready`
 * clears what the rooms had loaded. The page's fake gives both the same
 * session, where a real server's second would be new, so a room opened
 * between the two would sit empty (#355): tests start once both are in.
 */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
}


/** Everything the window asked of the shell and the servers, in order. */
async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The window's resizes, as the fake shell wrote them down. */
async function sizes(page: Page): Promise<string[]> {
  return (await did(page)).filter((line) => line.startsWith("size "));
}

/** The last room you were placed in, as the server was told (`room.focus`). */
async function placedIn(page: Page): Promise<string | null | undefined> {
  const said = (await did(page)).filter((line) => line.includes('"op":"room.focus"')).at(-1);
  if (said === undefined) return undefined;
  const frame = JSON.parse(said.slice(said.indexOf(":{") + 1)) as { d: { room_id: string | null } };
  return frame.d.room_id;
}

/** The desktop gave the window the room it asked for (the fake shell only writes it down). */
async function grown(page: Page) {
  await page.setViewportSize({ width: 1120, height: 820 });
}

const room = (page: Page, name: string) => page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: new RegExp(`^#${name}\\b`) });
// A one-to-one DM lives on its person's row (#351): clicking them opens it, as a preview tab.
const dm = (page: Page, name: string) => page.getByRole("list", { name: "People here" }).getByRole("button", { name: new RegExp(`^${name}`) }).first();
const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const showing = (page: Page) => page.getByRole("tab", { selected: true });

test("a room clicked in the list opens beside it, in the same window, with the cursor in its box", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  await expect(box(page)).toBeFocused();
  expect(await did(page)).toContain("history r-general?limit=100");
  // The window grew by the conversation's width; no other window was opened.
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820"]);
  expect((await did(page)).filter((line) => line.startsWith("next_open_"))).toEqual([]);
});

test("while a room shows beside the list you're in it; folded away, you're around again", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await expect.poll(() => placedIn(page)).toBe("r-general");
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await expect.poll(() => placedIn(page)).toBeNull();
});

test("folding shrinks the window to the list and keeps the tabs; unfolding brings them back as they were", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await dm(page, "Jules").click();
  await expect(showing(page)).toHaveAccessibleName(/^DM with Jules(, preview)?$/);

  // The fold button is at the conversations' own edge: folding takes it away,
  // so a second click can't land on the list's close button.
  const fold = page.getByRole("button", { name: "Fold back to your list" });
  const edge = await fold.boundingBox();
  const list = await page.locator("[data-screen='list']").boundingBox();
  expect((edge?.x ?? 0) >= (list?.width ?? Infinity)).toBe(true);
  await fold.click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 340x820"]);
  await page.setViewportSize({ width: 340, height: 820 });

  // Neutral: amber is for something new, like a DM nobody has read, and this is only a way back.
  const unfold = page.getByRole("button", { name: "Show your conversations" });
  await expect(unfold).toHaveAttribute("data-tone", "filled");
  await unfold.click();
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/]);
  await expect(showing(page)).toHaveAccessibleName(/^DM with Jules(, preview)?$/);
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 340x820", "size 1120x820"]);
});

test("a maximized window keeps its size to fold and unfold", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 820 });
  await open(page, "?one&maximized");
  await room(page, "general").click();
  await expect(showing(page)).toHaveAccessibleName("#general");
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.getByRole("button", { name: "Show your conversations" }).click();
  await expect(showing(page)).toHaveAccessibleName("#general");
  await page.waitForTimeout(200);
  expect(await sizes(page)).toEqual([]);
});

test("closing the last tab folds back to the list, with nothing left to unfold", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await page.getByRole("button", { name: "Close #general" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 340x820"]);
  await expect(page.getByRole("button", { name: "Show your conversations" })).toHaveCount(0);
  await expect.poll(() => placedIn(page)).toBeNull();
});

test("too narrow for both, the conversation takes the window, and its fold button goes back to the list", async ({ page }) => {
  // A narrow tile: the desktop didn't give the window the room it asked for.
  await open(page);
  await room(page, "general").click();
  await expect(showing(page)).toHaveAccessibleName("#general");
  await expect(page.locator("[data-screen='list']")).toBeHidden();
  const pane = await page.locator(".nx-side").boundingBox();
  expect(pane?.width).toBe(340);
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
});

test("a person's card opened from the list sits over the list, not over the conversation", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  const dave = page.getByRole("list", { name: "People here" }).locator(":scope > li").filter({ hasText: "Dave" });
  await dave.hover();
  await dave.getByRole("button", { name: "Dave's card" }).click();
  const card = await page.getByRole("dialog", { name: "Dave" }).boundingBox();
  const list = await page.locator("[data-screen='list']").boundingBox();
  expect(card).not.toBeNull();
  expect((card?.x ?? 0) + (card?.width ?? 0)).toBeLessThanOrEqual((list?.x ?? 0) + (list?.width ?? 0));
});

// A person clicked in the list opens in a preview tab (#351): looking around
// doesn't pile up tabs, and typing in one keeps it.
test("a person opened from the list is a preview: the next person takes its tab, and typing keeps it (#351)", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  const tabs = page.getByRole("tab");
  await dm(page, "Jules").click();
  await expect(tabs).toHaveText([/general/, /Jules/]);
  await expect(showing(page)).toHaveAccessibleName("DM with Jules, preview");
  await expect(page.locator(".k-tab[data-preview='yes'] .k-tab-title")).toHaveCSS("font-style", "italic");
  // Somebody you've never talked with: the DM is made, and takes Jules's place.
  await dm(page, "Callie").click();
  await expect(tabs).toHaveText([/general/, /Callie/]);
  await expect(showing(page)).toHaveAccessibleName("DM with Callie, preview");
  // Typing keeps it, so the next person gets a tab of their own.
  await box(page).pressSequentially("hey");
  await expect(showing(page)).toHaveAccessibleName("DM with Callie");
  await expect(page.locator(".k-tab[data-preview='yes']")).toHaveCount(0);
  await dm(page, "Jules").click();
  await expect(tabs).toHaveText([/general/, /Callie/, /Jules/]);
  // A room is never a preview.
  await room(page, "weekend-plans").click();
  await expect(tabs).toHaveText([/general/, /Callie/, /Jules/, /weekend-plans/]);
});

test("the list marks what's showing beside it: a room's row, or the person whose DM it is (#351)", async ({ page }) => {
  await open(page);
  const person = (name: string) => page.getByRole("list", { name: "People here" }).locator(":scope > li").filter({ hasText: name });
  const general = page.getByRole("list", { name: "Rooms" }).locator(":scope > li").filter({ hasText: "general" });
  await dm(page, "Jules").click();
  await grown(page);
  await expect(person("Jules")).toHaveAttribute("data-selected", "yes");
  await expect(general).not.toHaveAttribute("data-selected", "yes");
  await room(page, "general").click();
  await expect(general).toHaveAttribute("data-selected", "yes");
  await expect(person("Jules")).not.toHaveAttribute("data-selected", "yes");
  // Folded away, nothing is showing, so nothing is marked.
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await expect(page.locator("[data-screen='list'] li[data-selected='yes']")).toHaveCount(0);
});

// A one-to-one DM beside the list is its person (#351): their card on top,
// the conversation under it.
test("a one-to-one DM beside the list opens on their card: their name, where they are, their whole status, their fields and Knock (#351)", async ({ page }) => {
  await open(page);
  await dm(page, "Jules").click();
  await grown(page);
  const head = page.locator(".nx-pane-head[data-person='yes']");
  await expect(head.locator(".nx-pane-title [data-kit='Name']")).toHaveText("Jules");
  await expect(head.locator(".nx-pane-where")).toHaveText("in #general");
  await expect(head.locator(".nx-pane-sub")).toHaveText("speakers: finally set up");
  await expect(head.locator(".nx-person-fields dt")).toHaveText([/listening to/i]);
  await expect(head.getByRole("button", { name: "Knock" })).toBeEnabled();
  // Nothing in it is cut off: it takes the lines it needs.
  const clipped = await head.evaluate((node) =>
    [...node.querySelectorAll<HTMLElement>(".nx-pane-sub, .nx-person-fields dd, .nx-pane-title")].filter((one) => one.scrollWidth > one.clientWidth + 1).length,
  );
  expect(clipped).toBe(0);
  // A room keeps its one line.
  await room(page, "general").click();
  await expect(page.locator(".nx-pane-head[data-kind='room']")).toHaveCSS("height", "40px");
  await expect(page.locator(".nx-pane-head[data-person='yes']")).toHaveCount(0);
});

test("in their card, a refused knock says why in place of their status, whole, and never Knocked (#351, #288)", async ({ page }) => {
  await open(page, "?one&limit");
  await dm(page, "Jules").click();
  await grown(page);
  const head = page.locator(".nx-pane-head[data-person='yes']");
  await head.getByRole("button", { name: "Knock" }).click();
  const said = head.getByRole("status");
  await expect(said).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
  expect(await said.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(head.getByRole("button", { name: "Knock" })).not.toHaveText("Knocked");
});

test("moves between tabs and closes them from the keyboard, even while typing", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await dm(page, "Jules").click();
  await room(page, "weekend-plans").click();
  await expect(showing(page)).toHaveAccessibleName("#weekend-plans");
  await box(page).click();
  await page.keyboard.press("Control+Tab");
  await expect(showing(page)).toHaveAccessibleName("#general");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(showing(page)).toHaveAccessibleName("#weekend-plans");
  await page.keyboard.press("Control+PageUp");
  await expect(showing(page)).toHaveAccessibleName(/^DM with Jules(, preview)?$/);
  await page.keyboard.press("Alt+1");
  await expect(showing(page)).toHaveAccessibleName("#general");
  await page.keyboard.press("Alt+9");
  await expect(showing(page)).toHaveAccessibleName("#weekend-plans");
  await page.keyboard.press("Control+Shift+PageUp");
  await expect(page.getByRole("tab")).toHaveText([/general/, /weekend-plans/, /Jules/]);
  await page.keyboard.press("Control+Shift+PageDown");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/, /weekend-plans/]);
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/]);
  await expect(showing(page)).toHaveAccessibleName(/^DM with Jules(, preview)?$/);
});

test("pops the showing tab out into its own window, and its draft goes with it", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await dm(page, "Jules").click();
  await page.getByRole("tab", { name: "#general" }).click();
  await box(page).click();
  await page.keyboard.type("half a thought");
  await page.getByRole("button", { name: "Open in its own window" }).click();
  await expect
    .poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_conversation")))
    .toEqual([`next_open_conversation:${JSON.stringify({ server: HOME, room: "r-general", kind: "room", message: null })}`]);
  await expect(page.getByRole("tab")).toHaveText([/Jules/]);
  const left = await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${HOME}#r-general`);
  expect(JSON.parse(left ?? "{}")).toMatchObject({ text: "half a thought" });
});

test("a conversation back from its own window opens beside the list, with its draft", async ({ page }) => {
  await open(page);
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ text: "still typing", at: Date.now() })), `linger.next.handoff.${HOME}#d-jules`);
  // Its window's Back beside your list, as the owner hears it.
  await expect
    .poll(async () => {
      await page.evaluate((server) => window.core?.ask("next:intent", { kind: "tabs", server, roomId: "d-jules" }), HOME);
      return page.getByRole("tab", { name: "DM with Jules", selected: true }).count();
    })
    .toBe(1);
  await expect(box(page)).toHaveValue("still typing");
  // Taken once: it isn't waiting to turn up again.
  expect(await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${HOME}#d-jules`)).toBeNull();
});

test("switching to windows moves every tab into its own window, the one showing last, and folds", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await room(page, "weekend-plans").click();
  await dm(page, "Jules").click();
  await box(page).click();
  await page.keyboard.type("for jules");
  // Already beside the list: nothing moves.
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "conversations", mode: "tabs" }));
  await page.waitForTimeout(300);
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "conversations", mode: "windows" }));
  await expect(page.getByRole("tab")).toHaveCount(0);
  const rooms = (await did(page))
    .filter((line) => line.startsWith("next_open_conversation"))
    .map((line) => (JSON.parse(line.slice("next_open_conversation:".length)) as { room: string }).room);
  expect(rooms).toEqual(["r-general", "r-plans", "d-jules"]);
  const left = await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${HOME}#d-jules`);
  expect(JSON.parse(left ?? "{}")).toMatchObject({ text: "for jules" });
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 340x820"]);
});

test("the tabs and the fold come back after a restart as they were left", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await dm(page, "Jules").click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.reload();
  await settled(page);
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/]);
  await expect(showing(page)).toHaveAccessibleName(/^DM with Jules(, preview)?$/);
  // Folded, it comes back folded, with them kept.
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await page.reload();
  await settled(page);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show your conversations" })).toBeVisible();
});

test("a half-typed line outlasts its tab and a restart, and goes once it's sent (decision 11)", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await dm(page, "Jules").click();
  await page.getByRole("tab", { name: "#general" }).click();
  await box(page).fill("see you at the");
  await page.getByRole("button", { name: "Close #general" }).click();
  await expect(page.getByRole("tab", { name: "#general" })).toHaveCount(0);
  await room(page, "general").click();
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(box(page)).toHaveValue("see you at the");
  await page.reload();
  await settled(page);
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(box(page)).toHaveValue("see you at the");
  await box(page).fill("see you at the porch");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  expect(await page.evaluate(() => localStorage.getItem("linger.next.drafts"))).toBeNull();
});

test("with several servers, a tab carries its server's stripe and name, and the header says which", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page, "");
  await page.getByRole("list", { name: "Rooms on The Good Company" }).getByRole("button", { name: /^#general\b/ }).click();
  await page.locator(".nx-srv-toggle").nth(1).click();
  await page.getByRole("list", { name: "Rooms on Ashen Lanterns" }).getByRole("button").first().click();
  await expect(showing(page)).toHaveAccessibleName(/, Ashen Lanterns$/);
  await expect(page.getByRole("tab", { name: "#general, The Good Company" })).toBeVisible();
  const stripes = await page.locator(".k-tab[data-stripe='yes']").evaluateAll((tabs) => tabs.map((tab) => getComputedStyle(tab).getPropertyValue("--tab-stripe").trim()));
  const palette = await page.evaluate(() => ["amber", "violet"].map((key) => getComputedStyle(document.documentElement).getPropertyValue(`--name-${key}`).trim()));
  expect(stripes).toEqual(palette);
  await expect(page.locator(".nx-pane-server")).toHaveText("Ashen Lanterns");
});

test("with one server, tabs and headers say nothing about servers", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await expect(page.getByRole("tab", { name: "#general" })).toBeVisible();
  await expect(page.locator(".k-tab[data-stripe='yes']")).toHaveCount(0);
  await expect(page.locator(".nx-pane-server")).toHaveCount(0);
});

test("a brand new DM opened beside the list waits for its conversation rather than vanishing", async ({ page }) => {
  await open(page);
  await grown(page);
  // A banner for a DM the server has only just made: the list hears of it after.
  await expect
    .poll(async () => {
      await page.evaluate((server) => window.core?.banner({ server, room: "d-dave", message: "m000001" }), HOME);
      return page.locator(".nx-side").count();
    })
    .toBe(1);
  await page.evaluate((server) =>
    window.core?.frame(server, { op: "presence.update", d: { user_id: "u-eli", state: "away", room_id: null, away_message: "back soon" } } as never),
  HOME);
  await page.evaluate((server) =>
    window.core?.frame(server, {
      op: "room.create",
      d: { id: "d-dave", slug: "d-dave", name: "", topic: null, kind: "dm", member_ids: ["u-matt", "u-dave"], position: 0, archived_at: null, last_message_id: null },
    } as never),
  HOME);
  await expect(showing(page)).toHaveAccessibleName("DM with Dave");
});

test("a room you've left keeps only its newest page, and you come back to the newest (CONV-14)", async ({ page }) => {
  await open(page, "?one&many=600");
  await room(page, "general").click();
  await grown(page);
  const log = page.getByRole("log");
  const newest = page.getByRole("button", { name: "Back to the newest" });
  await expect(page.locator('[data-message="m000016"]')).toBeVisible();
  // Read back a few pages.
  const olderPages = async () => (await did(page)).filter((line) => line.startsWith("history r-general?limit=100&before=")).length;
  await expect
    .poll(
      async () => {
        await log.evaluate((node) => {
          node.scrollTop = 0;
        });
        return olderPages();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(4);
  const heldHeight = await log.evaluate((node) => node.scrollHeight);
  // Somewhere else, and back.
  await room(page, "listening-room").click();
  await expect(showing(page)).toHaveAccessibleName("#listening-room");
  await page.getByRole("tab", { name: "#general" }).click();
  await expect(page.locator('[data-message="m000016"]')).toBeVisible();
  await expect(newest).toHaveCount(0);
  const backHeight = await log.evaluate((node) => node.scrollHeight);
  expect(backHeight).toBeLessThan(heldHeight / 2);
});

const foot = (page: Page) => page.getByRole("navigation", { name: "Media and search" });
const searchBox = (page: Page) => page.getByRole("textbox", { name: "Search", exact: true });

test("Media and Search open as tabs beside the list, and a search hit opens its conversation there, at the message", async ({ page }) => {
  await open(page);
  await foot(page).getByRole("button", { name: "Media" }).click();
  await grown(page);
  await expect(page.getByRole("tab", { name: "Media", selected: true })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Media" })).toBeVisible();
  // Media and Search don't put you in a room.
  await page.waitForTimeout(200);
  expect((await placedIn(page)) ?? null).toBeNull();
  await foot(page).getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("tab", { name: "Search", selected: true })).toBeVisible();
  await searchBox(page).fill("khruangbin");
  await page.getByRole("tabpanel", { name: "Search" }).getByText("Khruangbin", { exact: false }).first().click();
  // Another tab, beside the others, around the message.
  await expect(showing(page)).toHaveAccessibleName("#general");
  await expect(page.getByRole("tab")).toHaveText([/Media/, /Search/, /general/]);
  await expect.poll(async () => (await did(page)).filter((line) => /^history r-general\?around=/.test(line)).length).toBe(1);
  await expect.poll(() => placedIn(page)).toBe("r-general");
});

test("Ctrl+K opens Search beside the list, and puts the cursor back in its box when asked again", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await box(page).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("tab", { name: "Search", selected: true })).toBeVisible();
  await expect(searchBox(page)).toBeFocused();
  await page.getByRole("tab", { name: "#general" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("tab", { name: "Search", selected: true })).toBeVisible();
  await expect(searchBox(page)).toBeFocused();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a Media tab pops out into its own window, and comes back when that window asks", async ({ page }) => {
  await open(page);
  await foot(page).getByRole("button", { name: "Media" }).click();
  await grown(page);
  await page.getByRole("button", { name: "Open in its own window" }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_tool"))).toEqual([`next_open_tool:${JSON.stringify({ which: "media" })}`]);
  await expect(page.getByRole("tab")).toHaveCount(0);
  // Its window's Back beside your list, as the owner hears it.
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "tool", which: "media" }));
  await expect(page.getByRole("tab", { name: "Media", selected: true })).toBeVisible();
});

test("with each in its own window, Media and Search open in windows of their own, and switching there moves their tabs too", async ({ page }) => {
  await open(page);
  await foot(page).getByRole("button", { name: "Search" }).click();
  await grown(page);
  await room(page, "general").click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "conversations", mode: "windows" }));
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect.poll(async () => (await did(page)).filter((line) => /^next_open_(tool|conversation)/.test(line)).map((line) => line.split(":")[0])).toEqual([
    "next_open_tool",
    "next_open_conversation",
  ]);
  // From now on, Media opens a window of its own.
  await page.setViewportSize({ width: 340, height: 820 });
  await foot(page).getByRole("button", { name: "Media" }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_tool")).at(-1)).toBe(`next_open_tool:${JSON.stringify({ which: "media" })}`);
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("Media and Search tabs come back after a restart with the rest", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await foot(page).getByRole("button", { name: "Media" }).click();
  await expect(page.getByRole("tab")).toHaveText([/general/, /Media/]);
  await page.reload();
  await settled(page);
  await expect(page.getByRole("tab")).toHaveText([/general/, /Media/]);
  await expect(page.getByRole("tab", { name: "Media", selected: true })).toBeVisible();
});

const line = (page: Page) => page.getByRole("separator", { name: "Width of your list" });
const listWide = async (page: Page) => (await page.locator("[data-screen='list']").boundingBox())?.width;

/** Drag the line between the list and the conversations by `by` pixels. */
async function drag(page: Page, by: number) {
  const box = await line(page).boundingBox();
  const x = box?.x ?? 0;
  const y = (box?.y ?? 0) + 400;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 5 });
  await page.mouse.up();
}

test("dragging the line beside the list resizes the list; the window keeps its size, and folds back to the new width", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await expect(line(page)).toHaveAttribute("aria-valuenow", "340");
  await drag(page, 100);
  await expect(line(page)).toHaveAttribute("aria-valuenow", "440");
  expect(await listWide(page)).toBe(440);
  // The window didn't change size: the conversations took what was left.
  expect(await sizes(page)).toEqual(["size 1120x820"]);
  await page.getByRole("button", { name: "Fold back to your list" }).click();
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 440x820"]);
  // And unfolds to the same whole: the list as dragged, the conversations as left.
  await page.setViewportSize({ width: 440, height: 820 });
  await page.getByRole("button", { name: "Show your conversations" }).click();
  await expect.poll(() => sizes(page)).toEqual(["size 1120x820", "size 440x820", "size 1120x820"]);
});

test("the line moves from the keyboard too, is kept after a restart, and Enter puts it back", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await line(page).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(line(page)).toHaveAttribute("aria-valuenow", "372");
  await page.reload();
  await settled(page);
  await expect(line(page)).toHaveAttribute("aria-valuenow", "372");
  expect(await listWide(page)).toBe(372);
  await line(page).focus();
  await page.keyboard.press("Enter");
  await expect(line(page)).toHaveAttribute("aria-valuenow", "340");
});

test("a list dragged wide is squeezed, not lost, when the window gets narrower", async ({ page }) => {
  await open(page);
  await room(page, "general").click();
  await grown(page);
  await drag(page, 200);
  await expect(line(page)).toHaveAttribute("aria-valuenow", "540");
  // Narrower: the conversation keeps its room, and the list gives way.
  await page.setViewportSize({ width: 900, height: 820 });
  await expect(line(page)).toHaveAttribute("aria-valuenow", "480");
  // Wider again: back to where it was dragged.
  await page.setViewportSize({ width: 1120, height: 820 });
  await expect(line(page)).toHaveAttribute("aria-valuenow", "540");
});

