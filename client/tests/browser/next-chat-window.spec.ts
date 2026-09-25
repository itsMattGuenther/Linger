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

test("remembers open tabs across a restart", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.owner?.open("d-jules"));
  await expect(page.getByRole("tab", { name: "DM with Jules" })).toBeVisible();
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-plans");
  await expect(page.getByRole("tab")).toHaveText([/general/, /Jules/, /weekend-plans/]);
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

test("with push-to-talk on, holding Control in this window talks through the list window", async ({ page }) => {
  await open(page, "room=r-general&ptt");
  // The window has set itself up (it reports the room in the same pass that
  // starts listening for the key) before anyone could reach for Control.
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "room", server: SERVER, roomId: "r-general" });
  await page.keyboard.down("Control");
  await page.keyboard.up("Control");
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "voice.talk")).toEqual([
    { kind: "voice.talk", down: true },
    { kind: "voice.talk", down: false },
  ]);
});

test("closing the last tab closes the window and tells the list window", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Close #general" }).click();
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page)).at(-1)).toEqual({ kind: "closing" });
});

test("says so when the list window doesn't answer", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&noowner");
  await page.clock.fastForward(6_000);
  await expect(page.getByRole("status")).toContainText("The list window didn't answer.");
});
