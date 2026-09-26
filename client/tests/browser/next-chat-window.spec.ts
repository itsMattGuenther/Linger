import { expect, type Page, test } from "@playwright/test";

// The chat window with its wiring (tests/fixtures/next-chat-window.tsx): the
// real ChatWindow, the store and the sharing code, with the desktop shell,
// the list window and the server faked in the page. The views are measured in
// next-chat.spec.ts; this is about what the window asks for and when.

test.use({ viewport: { width: 780, height: 820 } });

const SERVER = "https://good-company.example";
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;

async function open(page: Page, query = "room=r-general") {
  await page.route(`${SERVER}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.goto(`/tests/fixtures/next-chat-window.html?${query}`);
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

/** Everything the window asked of the shell, the owner and the server, in order. */
async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

function intents(asked: string[]): Record<string, unknown>[] {
  return asked.filter((line) => line.startsWith("intent:")).map((line) => JSON.parse(line.slice("intent:".length)) as Record<string, unknown>);
}

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const log = (page: Page) => page.getByRole("log");

test("catches up with the list window and opens the conversation, with a borrowed sign-in", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tab", { name: "#general" })).toHaveAttribute("aria-selected", "true");
  await expect(log(page)).toContainText("Putting it on now. Door's open if anyone wants to drop into voice.");
  expect(await did(page)).toContain("GET /rooms/r-general/messages?limit=100 as token-1");
  // It tells the owner which room it shows, for presence.
  expect(intents(await did(page))).toContainEqual({ kind: "room", server: SERVER, roomId: "r-general" });
});

test("marks the newest message read through the list window, once", async ({ page }) => {
  await open(page);
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "read")).toEqual([
    { kind: "read", server: SERVER, roomId: "r-general", messageId: "m000016" },
  ]);
  // Something new arrives while you're reading at the bottom: that's read too.
  const id = await page.evaluate(() => window.owner?.say("r-general", "u-eli", "one more thing"));
  await expect(log(page)).toContainText("one more thing");
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "read").at(-1)).toEqual({
    kind: "read",
    server: SERVER,
    roomId: "r-general",
    messageId: id,
  });
});

test("opens on where you left off when something arrived since", async ({ page }) => {
  await open(page, "room=r-listening");
  await expect(page.getByText("you left off here")).toBeVisible();
  // History around the last message you'd read, not the newest page.
  expect(await did(page)).toContain("GET /rooms/r-listening/messages?around=m000019&limit=100 as token-1");
});

test("a token that ran out is renewed through the list window, and the page loads anyway", async ({ page }) => {
  await open(page, "room=r-general&expired");
  await expect(log(page)).toContainText("Putting it on now.");
  const asked = await did(page);
  expect(asked).toContain("token:token-1");
  expect(asked).toContain("GET /rooms/r-general/messages?limit=100 as token-2");
});

test("sends what you type at once, and keeps the cursor in the box", async ({ page }) => {
  await open(page);
  await box(page).click();
  await page.keyboard.type("on my way");
  await page.keyboard.press("Enter");
  await expect(log(page)).toContainText("on my way");
  await expect(box(page)).toHaveValue("");
  await expect(box(page)).toBeFocused();
  expect(await did(page)).toContain("POST /rooms/r-general/messages as token-1");
});

test("typing is said through the list window's connection", async ({ page }) => {
  await open(page);
  await box(page).click();
  await page.keyboard.type("h");
  await expect.poll(() => did(page)).toContain('gateway:{"op":"typing.start","d":{"room_id":"r-general"}}');
});

test("a send the server refuses says why and keeps the words", async ({ page }) => {
  await open(page, "room=r-general&fail");
  await box(page).click();
  await page.keyboard.type("is this thing on");
  await page.keyboard.press("Enter");
  await expect(page.getByText("The server is busy. Try again in a moment.")).toBeVisible();
  await expect(box(page)).toHaveValue("is this thing on");
});

test("rooms sent while it was still opening aren't lost: each gets a tab, the last one showing", async ({ page }) => {
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&missed=r-listening,r-plans");
  await expect(page.getByRole("tab", { name: "#weekend-plans" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveText([/#general/, /#listening-room/, /#weekend-plans/]);
  // Asked once, after it was listening.
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("ask:next:opens"))).toHaveLength(1);
});

test("a conversation opened from the list gets a tab, and the cursor", async ({ page }) => {
  await open(page);
  // The cursor is somewhere else, as it would be after reading for a while.
  await page.getByRole("tab", { name: "#general" }).focus();
  await expect(box(page)).not.toBeFocused();
  await page.evaluate(() => window.owner?.open("d-jules"));
  await expect(page.getByRole("tab", { name: "DM with Jules" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Jules");
  await expect(box(page)).toBeFocused();
  // Reads and presence arrive in any order: the last room reported is the DM.
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "room").at(-1)).toEqual({ kind: "room", server: SERVER, roomId: "d-jules" });
  // Opening it again shows the same tab rather than adding another.
  await page.evaluate(() => window.owner?.open("r-general"));
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a name in a conversation opens that person's card beside it; Escape gives the name the keyboard back", async ({ page }) => {
  await open(page);
  const name = page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Eli" }).last();
  await name.click();
  const card = page.getByRole("dialog", { name: "Eli" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("in #general");
  // Beside the name: just under it, starting where it starts (or pulled in
  // from the window's edge). Measured once it has finished opening.
  await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
  const [at, from] = await Promise.all([card.boundingBox(), name.boundingBox()]);
  expect(at && from).toBeTruthy();
  if (!at || !from) return;
  expect(Math.abs(at.x - from.x)).toBeLessThanOrEqual(1);
  const under = Math.abs(at.y - (from.y + from.height + 4));
  const over = Math.abs(at.y + at.height - (from.y - 4));
  expect(Math.min(under, over), `card at ${at.y}–${at.y + at.height}, name at ${from.y}–${from.y + from.height}`).toBeLessThanOrEqual(1);
  await expect.poll(() => card.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(name).toBeFocused();
  // Your own name, and a name only drawn once for a run of messages, open nothing.
  await expect(page.locator(".nx-msg-person", { hasText: "Matt" })).toHaveCount(0);
  await expect(page.locator(".nx-msg:not([data-head='yes']) .nx-msg-person")).toHaveCount(0);
});

test("from a name's card, Message opens the DM here and Knock knocks", async ({ page }) => {
  await open(page);
  await page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Eli" }).last().click();
  const card = page.getByRole("dialog", { name: "Eli" });
  await card.getByRole("button", { name: "Knock" }).click();
  await expect(card.getByRole("button", { name: "Knocked" })).toBeVisible();
  await expect.poll(() => did(page)).toContain("POST /knock as token-1");
  await card.getByRole("button", { name: "Message" }).click();
  await expect(page.getByRole("tab", { name: "DM with Eli" })).toHaveAttribute("aria-selected", "true");
  await expect(card).toHaveCount(0);
  expect(await did(page)).toContain("POST /dms as token-1");
});

test("the voice strip shows whose microphone is off, as its glyph", async ({ page }) => {
  await open(page, "room=r-general&ptt");
  const here = page.getByRole("list", { name: "In voice here" });
  // Push-to-talk keeps you muted until you talk.
  await expect(here.getByRole("listitem").filter({ hasText: "you" }).locator(".k-chip-state")).toHaveText("Muted");
  await expect(here.getByRole("listitem").filter({ hasText: "Eli" }).locator(".k-chip-state")).toHaveCount(0);
});

test("you light up in the voice strip while you talk, as others do (#215)", async ({ page }) => {
  await open(page, "room=r-general&talking");
  const here = page.getByRole("list", { name: "In voice here" });
  await expect(here.getByRole("listitem").filter({ hasText: "you" }).locator("[data-kit='Chip']")).toHaveAttribute("data-active", "yes");
  await expect(page.locator(".nx-strip [data-kit='VoiceGlyph']")).toHaveAttribute("data-speaking", "yes");
});

test("a message is drawn in its sender's message face, and only ever a sans one", async ({ page }) => {
  await open(page);
  const text = page.locator(".nx-msg").filter({ hasText: "A bit of Khruangbin" }).locator(".nx-text");
  const face = () => text.evaluate((node) => getComputedStyle(node).fontFamily.toLowerCase());
  const body = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-body").toLowerCase());
  const firstOf = (families: string) => families.split(",")[0]?.trim().replaceAll('"', "") ?? "";
  expect(firstOf(await face())).toBe(firstOf(body));
  await page.evaluate(() => window.owner?.messageFont("u-eli", "space-grotesk"));
  await expect.poll(face).toContain("space grotesk");
  // A face kept for names (mono here) draws in the body face instead.
  await page.evaluate(() => window.owner?.messageFont("u-eli", "jetbrains-mono"));
  await expect.poll(async () => firstOf(await face())).toBe(firstOf(body));
  expect(await face()).not.toContain("mono");
});

test("a brand new DM opened into the tabs waits for its conversation rather than vanishing", async ({ page }) => {
  await open(page);
  // The list opened a DM the server has only just made: this window hears of it after.
  await page.evaluate(() => window.owner?.open("d-dave"));
  // Something else changes first.
  await page.evaluate(() =>
    window.owner?.frame({ op: "presence.update", d: { user_id: "u-eli", state: "away", room_id: null, away_message: "back soon" } }),
  );
  await page.evaluate(() =>
    window.owner?.frame({
      op: "room.create",
      d: { id: "d-dave", slug: "d-dave", name: "", topic: null, kind: "dm", member_ids: ["u-matt", "u-dave"], position: 0, archived_at: null, last_message_id: null },
    }),
  );
  await expect(page.getByRole("tab", { name: "DM with Dave" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a window opened on a DM it hasn't heard of yet waits for it rather than closing", async ({ page }) => {
  await page.goto("/tests/fixtures/next-chat-window.html?room=d-dave");
  await page.waitForTimeout(300);
  expect(await did(page)).not.toContain("window:close");
  await page.evaluate(() =>
    window.owner?.frame({
      op: "room.create",
      d: { id: "d-dave", slug: "d-dave", name: "", topic: null, kind: "dm", member_ids: ["u-matt", "u-dave"], position: 0, archived_at: null, last_message_id: null },
    }),
  );
  await expect(page.getByRole("tab", { name: "DM with Dave" })).toHaveAttribute("aria-selected", "true");
  expect(await did(page)).not.toContain("window:close");
});

test("moves between tabs and closes them from the keyboard, even while typing", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.owner?.open("d-jules");
    window.owner?.open("r-plans");
  });
  const showing = page.getByRole("tab", { selected: true });
  await expect(showing).toHaveAccessibleName("#weekend-plans");
  await box(page).click();
  await page.keyboard.press("Control+Tab");
  await expect(showing).toHaveAccessibleName("#general");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(showing).toHaveAccessibleName("#weekend-plans");
  await page.keyboard.press("Control+PageUp");
  await expect(showing).toHaveAccessibleName("DM with Jules");
  await page.keyboard.press("Alt+1");
  await expect(showing).toHaveAccessibleName("#general");
  await page.keyboard.press("Alt+9");
  await expect(showing).toHaveAccessibleName("#weekend-plans");
  await page.keyboard.press("Control+Shift+PageUp");
  await expect(page.getByRole("tab")).toHaveText([/general/, /weekend-plans/, /Jules/]);
  await page.keyboard.press("Control+Shift+PageDown");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/, /weekend-plans/]);
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/]);
  await expect(showing).toHaveAccessibleName("DM with Jules");
});

test("Ctrl+K asks the list window for Search, and Ctrl+, for Settings, even while typing", async ({ page }) => {
  await open(page);
  await box(page).click();
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+,");
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "tool" || intent.kind === "settings")).toEqual([
    { kind: "tool", which: "search" },
    { kind: "settings" },
  ]);
  await expect(box(page)).toHaveValue("");
});

test("pops the showing tab out into its own window, and its draft goes with it", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.owner?.open("d-jules"));
  await page.getByRole("tab", { name: "#general" }).click();
  await box(page).click();
  await page.keyboard.type("half a thought");
  await page.getByRole("button", { name: "Open in its own window" }).click();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "popout", server: SERVER, roomId: "r-general" });
  await expect(page.getByRole("tab")).toHaveText([/Jules/]);
  const left = await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${SERVER}#r-general`);
  expect(JSON.parse(left ?? "{}")).toMatchObject({ text: "half a thought" });
});

test("a conversation in its own window: its header is the title bar, and Back to tabs takes it and its draft back", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(key, JSON.stringify({ text: "carried over", at: Date.now() }));
      sessionStorage.setItem("seeded", "yes");
    }
  }, `linger.next.handoff.${SERVER}#r-general`);
  await page.route(`${SERVER}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&single=1");
  const pane = page.getByRole("region", { name: "#general" });
  await expect(pane).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  const title = page.locator(".k-titlebar");
  await expect(title).toContainText("general");
  await expect(title).toContainText("Good company. No hurry.");
  // The draft that came with it is in the box, and the cursor is there.
  await expect(box(page)).toHaveValue("carried over");
  await expect(box(page)).toBeFocused();
  // It doesn't take over the tabs remembered for the chat window.
  expect(await page.evaluate(() => window.localStorage.getItem("linger.next.tabs"))).toBeNull();

  await page.keyboard.type(", and more");
  await page.getByRole("button", { name: "Back to tabs" }).click();
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page))).toContainEqual({ kind: "tabs", server: SERVER, roomId: "r-general" });
  const left = await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${SERVER}#r-general`);
  expect(JSON.parse(left ?? "{}")).toMatchObject({ text: "carried over, and more" });
});

test("a conversation back from its own window arrives with its draft", async ({ page }) => {
  await open(page);
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ text: "still typing", at: Date.now() })), `linger.next.handoff.${SERVER}#d-jules`);
  await page.evaluate(() => window.owner?.open("d-jules"));
  await expect(page.getByRole("tab", { name: "DM with Jules" })).toHaveAttribute("aria-selected", "true");
  await expect(box(page)).toHaveValue("still typing");
  // Taken once: it isn't waiting to turn up again.
  expect(await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${SERVER}#d-jules`)).toBeNull();
});

test("switching to windows moves every tab into its own window, the one showing last", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.owner?.open("d-jules");
    window.owner?.open("r-plans");
  });
  await page.getByRole("tab", { name: "DM with Jules" }).click();
  await box(page).click();
  await page.keyboard.type("for jules");
  // Already tabs: nothing moves. Proving nothing happens takes a moment's wait.
  await page.evaluate(() => window.owner?.mode("tabs"));
  await page.waitForTimeout(300);
  await expect(page.getByRole("tab")).toHaveCount(3);
  expect(await did(page)).not.toContain("window:close");
  await page.evaluate(() => window.owner?.mode("windows"));
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page)).filter((intent) => intent.kind === "popout")).toEqual([
    { kind: "popout", server: SERVER, roomId: "r-general" },
    { kind: "popout", server: SERVER, roomId: "r-plans" },
    { kind: "popout", server: SERVER, roomId: "d-jules" },
  ]);
  const left = await page.evaluate((key) => window.localStorage.getItem(key), `linger.next.handoff.${SERVER}#d-jules`);
  expect(JSON.parse(left ?? "{}")).toMatchObject({ text: "for jules" });
});

test("switching back to tabs sends a conversation's own window home", async ({ page }) => {
  await page.goto("/tests/fixtures/next-chat-window.html?room=d-jules&single=1");
  await expect(page.getByRole("region", { name: "Jules" })).toBeVisible();
  await page.evaluate(() => window.owner?.mode("tabs"));
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page))).toContainEqual({ kind: "tabs", server: SERVER, roomId: "d-jules" });
});

test("with several servers, a tab carries its server's stripe and name, and the header says which", async ({ page }) => {
  await open(page, "room=r-general&servers");
  await page.evaluate(() => window.owner?.open("a-raid-night", "https://ashen-lanterns.example"));
  const raid = page.getByRole("tab", { name: "#raid-night, Ashen Lanterns" });
  await expect(raid).toHaveAttribute("aria-selected", "true");
  // Two servers, two tabs, each striped in its own server's color.
  await expect(page.getByRole("tab", { name: "#general, The Good Company" })).toBeVisible();
  const stripes = await page.locator(".k-tab[data-stripe='yes']").evaluateAll((tabs) => tabs.map((tab) => getComputedStyle(tab).getPropertyValue("--tab-stripe").trim()));
  const palette = await page.evaluate(() => ["amber", "violet"].map((key) => getComputedStyle(document.documentElement).getPropertyValue(`--name-${key}`).trim()));
  expect(stripes).toEqual(palette);
  await expect(page.locator(".nx-pane-server")).toHaveText("Ashen Lanterns");
});

test("a server signed out of takes its tabs with it, and with nothing left the window closes", async ({ page }) => {
  await open(page, "room=r-general&servers");
  await page.evaluate(() => window.owner?.open("a-raid-night", "https://ashen-lanterns.example"));
  await expect(page.getByRole("tab", { name: "#raid-night, Ashen Lanterns" })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.owner?.signedOut("https://ashen-lanterns.example"));
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /#general/ })).toHaveAttribute("aria-selected", "true");
  expect(await did(page)).not.toContain("window:close");
  await page.evaluate((server) => window.owner?.signedOut(server), SERVER);
  await expect.poll(() => did(page)).toContain("window:close");
});

test("a server signed in to while the window is open can be opened in it", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.owner?.signInGuild());
  // Once this window has caught up with it, a room there opens as a tab.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.owner?.open("a-raid-night", "https://ashen-lanterns.example"));
      return page.getByRole("tab", { name: /#raid-night/ }).count();
    })
    .toBe(1);
  await expect(page.getByRole("tab", { name: "#raid-night, Ashen Lanterns" })).toHaveAttribute("aria-selected", "true");
});

test("a search hit opens its conversation at the message: one in reach is jumped to and marked", async ({ page }) => {
  await open(page);
  const first = (await page.evaluate(() => window.owner?.held("r-listening") ?? []))[0]?.id ?? "";
  await page.evaluate((id) => window.owner?.open("r-listening", undefined, id), first);
  await expect(page.getByRole("tab", { name: /#listening-room/ })).toHaveAttribute("aria-selected", "true");
  const row = page.locator(`[data-message="${first}"]`);
  await expect(row).toHaveAttribute("data-flash", "yes");
  await expect(row).toBeInViewport();
});

test("one far back reopens the room around it, then goes there", async ({ page }) => {
  await open(page, "room=r-general&many=600");
  await expect(page.locator(".nx-msg").first()).toBeVisible();
  await page.evaluate(() => window.owner?.open("r-general", undefined, "l0000040"));
  await expect.poll(() => did(page)).toContain("GET /rooms/r-general/messages?around=l0000040&limit=100 as token-1");
  const row = page.locator('[data-message="l0000040"]');
  await expect(row).toHaveAttribute("data-flash", "yes");
  await expect(row).toBeInViewport();
  await expect(row).toContainText("older message 40");
});

test("a window opened on a message goes there", async ({ page }) => {
  await open(page, "room=r-general&many=600&message=l0000300");
  const row = page.locator('[data-message="l0000300"]');
  await expect(row).toHaveAttribute("data-flash", "yes");
  await expect(row).toBeInViewport();
});

test("with one server, tabs and headers say nothing about servers", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tab", { name: "#general" })).toBeVisible();
  await expect(page.locator(".k-tab[data-stripe='yes']")).toHaveCount(0);
  await expect(page.locator(".nx-pane-server")).toHaveCount(0);
});

test("remembers open tabs across a restart", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.owner?.open("d-jules"));
  await expect(page.getByRole("tab", { name: "DM with Jules" })).toBeVisible();
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-plans");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/, /weekend-plans/]);
});

test("a half-typed line outlasts its tab and a restart, and goes once it's sent (decision 11)", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.owner?.open("d-jules"));
  await page.getByRole("tab", { name: "#general" }).click();
  await box(page).fill("see you at the");
  await page.getByRole("button", { name: "Close #general" }).click();
  await expect(page.getByRole("tab", { name: "#general" })).toHaveCount(0);
  await page.evaluate(() => window.owner?.open("r-general"));
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(box(page)).toHaveValue("see you at the");
  // A restart.
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general");
  await expect(box(page)).toHaveValue("see you at the");
  await box(page).fill("see you at the porch");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  expect(await page.evaluate(() => localStorage.getItem("linger.next.drafts"))).toBeNull();
});

test("a message is pinned and unpinned from its menu, and shows its pin (T-908)", async ({ page }) => {
  await open(page);
  const row = page.locator("[data-message]").filter({ hasText: "Khruangbin" }).first();
  await row.hover();
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect.poll(async () => (await did(page)).some((line) => /^POST \/messages\/[^/]+\/pin/.test(line))).toBe(true);
  await expect(row.locator(".nx-msg-pinned")).toHaveAttribute("title", "Pinned");
  await row.hover();
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect.poll(async () => (await did(page)).some((line) => /^DELETE \/messages\/[^/]+\/pin/.test(line))).toBe(true);
  await expect(row.locator(".nx-msg-pinned")).toHaveCount(0);
});

test("a knock from a DM says Knocked, unless the server refused it", async ({ page }) => {
  await open(page, "room=d-jules");
  await page.getByRole("button", { name: "Knock" }).click();
  await expect(page.getByRole("button", { name: "Knocked" })).toBeDisabled();
  expect(await did(page)).toContain("POST /knock as token-1");

  // Refused: back to Knock at once, well before the three seconds a knock shows for.
  await open(page, "room=d-jules&limit");
  await page.getByRole("button", { name: "Knock" }).click();
  await expect(page.getByRole("button", { name: "Knock" })).toBeEnabled({ timeout: 1_000 });
});

test("Join asks the list window to join voice here", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Join" }).click();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "voice.join", server: SERVER, roomId: "r-general" });
});

test("with push-to-talk on, holding the talk key in this window talks through the list window, and the shortcuts' Ctrl doesn't", async ({ page }) => {
  await open(page, "room=r-general&ptt");
  // The window has set itself up (it reports the room in the same pass that
  // starts listening for the key) before anyone could reach for the key.
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "room", server: SERVER, roomId: "r-general" });
  // Left Ctrl is the shortcuts' Ctrl (decision 6): no microphone.
  await page.keyboard.down("ControlLeft");
  await page.keyboard.up("ControlLeft");
  // Right Ctrl is the talk key unless somebody picked another.
  await page.keyboard.down("ControlRight");
  await page.keyboard.up("ControlRight");
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "voice.talk")).toEqual([
    { kind: "voice.talk", down: true },
    { kind: "voice.talk", down: false },
  ]);
  // A key picked in Settings, in another window, is the one from then on.
  await page.evaluate(() => localStorage.setItem("linger.voice.pushToTalkKey", "AltRight"));
  await page.keyboard.down("AltRight");
  await page.keyboard.up("AltRight");
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "voice.talk")).toHaveLength(4);
});

test("closing the last tab closes the window and tells the list window", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Close #general" }).click();
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page)).at(-1)).toEqual({ kind: "closing" });
});

test("says so when the list window doesn't answer, and asks again when told to", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&noowner");
  await page.clock.fastForward(6_000);
  await expect(page.getByRole("status")).toContainText("The list window didn't answer.");
  // It was only busy.
  await page.evaluate(() => window.owner?.wake());
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("tab", { name: /#general/ })).toBeVisible();
});
