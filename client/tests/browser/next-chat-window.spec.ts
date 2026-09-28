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

/** What the window asked the list window to do with your voice: Mute, Deafen, Leave. */
function voiceControls(asked: string[]): Record<string, unknown>[] {
  const prefix = "ask:next:voicecontrol:";
  return asked.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
}

/** Every sound this window played, in order (tests/fixtures/next/audio.ts). */
function sounds(asked: string[]): string[] {
  return asked.filter((line) => line.startsWith("sound:")).map((line) => line.slice("sound:".length));
}

const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
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
  // A name only drawn once for a run of messages opens nothing where it's hidden.
  await expect(page.locator(".nx-msg:not([data-head='yes']) .nx-msg-person")).toHaveCount(0);
});

// Your own name opens your card, the one friends see (#271): the same card,
// saying whose view it is, with Edit profile in place of Message and Knock.
test("your own name opens your card as friends see it, with Edit profile; focus goes in and comes back", async ({ page }) => {
  await open(page);
  const name = page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Matt" }).last();
  await expect(name).toHaveAttribute("aria-haspopup", "dialog");
  await name.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("dialog", { name: "Matt" });
  await expect(card).toBeVisible();
  await expect(card.locator(".nx-person-yours")).toHaveText("This is how friends see you");
  await expect(card).toContainText("in #general");
  await expect(card).toContainText("fixing the porch light (the real one)");
  await expect(card).toContainText("a design for this app");
  await expect(card.getByRole("button", { name: "Edit profile" })).toBeFocused();
  await expect(card.getByRole("button", { name: "Message" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Knock/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(name).toBeFocused();

  // Edit profile asks the list window for Settings, on Profile, and closes the card.
  await name.click();
  await card.getByRole("button", { name: "Edit profile" }).click();
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "settings")).toEqual([{ kind: "settings", section: "profile" }]);
  await expect(card).toHaveCount(0);
  await expect(name).toBeFocused();
  // Nothing was asked of the server on your behalf.
  expect(await did(page)).not.toContain("POST /knock as token-1");
  expect(await did(page)).not.toContain("POST /dms as token-1");
});

// The card beside your name in a wide conversation, at 100% and 200%, saved
// for a person to look at.
for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale });
    test("your card beside your name fits the window, with nothing cut off", async ({ page }) => {
      await open(page);
      const name = page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Matt" }).last();
      await name.click();
      const card = page.getByRole("dialog", { name: "Matt" });
      await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
      const [at, from] = await Promise.all([card.boundingBox(), name.boundingBox()]);
      const size = page.viewportSize();
      expect(at && from && size).toBeTruthy();
      if (!at || !from || !size) return;
      expect(Math.abs(at.x - from.x)).toBeLessThanOrEqual(1);
      expect(at.y).toBeGreaterThanOrEqual(8);
      expect(at.y + at.height).toBeLessThanOrEqual(size.height - 8);
      const clipped = await card.evaluate((node) =>
        [...node.querySelectorAll<HTMLElement>(".nx-person *")]
          .filter((one) => one.scrollWidth > one.clientWidth + 1 && getComputedStyle(one).textOverflow !== "ellipsis")
          .map((one) => one.className),
      );
      expect(clipped).toEqual([]);
      await page.mouse.move(0, 0);
      await card.screenshot({ path: `test-results/your-card/chat-${test.info().project.name}-${scale * 100}.png`, animations: "disabled" });
    });
  });
}

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

test("a knock the server refuses for the hour says, on the card, when you can knock again (#268)", async ({ page }) => {
  // The fake server refuses as the real one does: 429, RATE_LIMITED, and
  // retry_after_ms of 19 minutes 10 seconds, read by the real REST client.
  await open(page, "room=r-general&limit");
  await page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Eli" }).last().click();
  const card = page.getByRole("dialog", { name: "Eli" });
  await card.getByRole("button", { name: "Knock" }).click();
  await expect(card.getByRole("status")).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
  await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
  expect(await did(page)).toContain("POST /knock as token-1");
});

test("the voice strip shows whose microphone is off, as its glyph, and push-to-talk's closed key as nothing (#232)", async ({ page }) => {
  await open(page, "room=r-general&ptt");
  const here = page.getByRole("list", { name: "In voice here" });
  // Push-to-talk with the key up closes your microphone, but isn't a mute.
  await expect(here.getByRole("listitem").filter({ hasText: "you" }).locator(".k-chip-state")).toHaveCount(0);
  await expect(here.getByRole("listitem").filter({ hasText: "Eli" }).locator(".k-chip-state")).toHaveCount(0);
  // Eli mutes: the server says so, and the strip shows it.
  await page.evaluate(() =>
    window.owner?.frame({
      op: "voice.state",
      d: {
        room_id: "r-general",
        peers: [
          { session_id: "s-eli", user_id: "u-eli", controls: { muted: true, deafened: false } },
          { session_id: "s-jules", user_id: "u-jules", controls: { muted: false, deafened: false } },
          { session_id: "s-matt", user_id: "u-matt", controls: { muted: false, deafened: false } },
        ],
      },
    }),
  );
  await expect(here.getByRole("listitem").filter({ hasText: "Eli" }).locator(".k-chip-state")).toHaveText("Muted");
  await expect(here.getByRole("listitem").filter({ hasText: "you" }).locator(".k-chip-state")).toHaveCount(0);
});

test("you light up in the voice strip while you talk, as others do (#215)", async ({ page }) => {
  await open(page, "room=r-general&talking");
  const here = page.getByRole("list", { name: "In voice here" });
  await expect(here.getByRole("listitem").filter({ hasText: "you" }).locator("[data-kit='Chip']")).toHaveAttribute("data-active", "yes");
  await expect(page.locator(".nx-strip [data-kit='VoiceGlyph']")).toHaveAttribute("data-speaking", "yes");
});

test("in the room you're in voice in, the voice strip has your mute, deafen and leave, and the list window acts on them (#216)", async ({ page }) => {
  await open(page, "room=r-general&talking");
  const yours = page.getByRole("group", { name: "Your voice" });
  await expect(yours.getByRole("button")).toHaveCount(3);
  for (const name of ["Mute", "Deafen", "Leave voice"]) {
    const button = yours.getByRole("button", { name });
    await expect(button).toHaveAttribute("data-kit", "IconButton");
    await expect(button).toHaveText("");
  }
  await yours.getByRole("button", { name: "Mute" }).click();
  await expect(yours.getByRole("button", { name: "Muted" })).toBeVisible();
  await yours.getByRole("button", { name: "Deafen" }).click();
  await expect(yours.getByRole("button", { name: "Deafened" })).toBeVisible();
  await yours.getByRole("button", { name: "Leave voice" }).click();
  await expect(page.getByRole("group", { name: "Your voice" })).toHaveCount(0);
  await expect.poll(async () => voiceControls(await did(page))).toEqual([{ control: "mute", on: true }, { control: "deafen", on: true }, { control: "leave" }]);
});

test("Mute, Deafen and Leave on the voice strip sound in this window, once the list window has made the change (#241)", async ({ page }) => {
  await open(page, "room=r-general&talking&hold");
  const yours = page.getByRole("group", { name: "Your voice" });
  // Pressed: the list window is asked, and nothing sounds while it's still making the change.
  await yours.getByRole("button", { name: "Mute" }).click();
  await expect.poll(async () => voiceControls(await did(page))).toEqual([{ control: "mute", on: true }]);
  await page.waitForTimeout(150);
  expect(sounds(await did(page))).toEqual([]);
  await expect(yours.getByRole("button", { name: "Mute" })).toBeVisible();
  // Made: the button shows it, and its sound plays here.
  await page.evaluate(() => window.owner?.finish());
  await expect(yours.getByRole("button", { name: "Muted" })).toBeVisible();
  await expect.poll(async () => sounds(await did(page))).toEqual(["mute"]);

  // Past the player's guard against a burst: one sound of a kind per 100 ms.
  await page.waitForTimeout(150);
  await yours.getByRole("button", { name: "Deafen" }).click();
  await expect.poll(async () => voiceControls(await did(page))).toHaveLength(2);
  await page.evaluate(() => window.owner?.finish());
  await expect.poll(async () => sounds(await did(page))).toEqual(["mute", "deafen"]);

  await yours.getByRole("button", { name: "Leave voice" }).click();
  await expect.poll(async () => voiceControls(await did(page))).toHaveLength(3);
  await page.evaluate(() => window.owner?.finish());
  await expect(page.getByRole("group", { name: "Your voice" })).toHaveCount(0);
  await expect.poll(async () => sounds(await did(page))).toEqual(["mute", "deafen", "voice-leave"]);
  // Once each.
  await page.waitForTimeout(300);
  expect(sounds(await did(page))).toEqual(["mute", "deafen", "voice-leave"]);
});

test("a Mute the list window couldn't make makes no sound (#241)", async ({ page }) => {
  await open(page, "room=r-general&talking&refuse");
  const yours = page.getByRole("group", { name: "Your voice" });
  await yours.getByRole("button", { name: "Mute" }).click();
  await expect.poll(async () => voiceControls(await did(page))).toEqual([{ control: "mute", on: true }]);
  await page.waitForTimeout(300);
  expect(sounds(await did(page))).toEqual([]);
  await expect(yours.getByRole("button", { name: "Mute" })).toBeVisible();
});

test("the sound settings rule the voice strip's sounds as they do the voice bar's: its switch and Mute all silence them, quiet hours don't (#241)", async ({ page }) => {
  await open(page, "room=r-general&talking");
  const yours = page.getByRole("group", { name: "Your voice" });
  // "Mute and deafen controls" off.
  await page.evaluate(() => localStorage.setItem("linger.sound.categories", JSON.stringify({ controls: false })));
  await yours.getByRole("button", { name: "Mute" }).click();
  await expect(yours.getByRole("button", { name: "Muted" })).toBeVisible();
  // Back on, but every sound muted.
  await page.evaluate(() => {
    localStorage.setItem("linger.sound.categories", JSON.stringify({ controls: true }));
    localStorage.setItem("linger.sound.muted", "true");
  });
  await yours.getByRole("button", { name: "Muted" }).click();
  await expect(yours.getByRole("button", { name: "Mute" })).toBeVisible();
  // Quiet hours all day: they hush what arrives on its own, not what you press (#186).
  await page.evaluate(() => {
    localStorage.setItem("linger.sound.muted", "false");
    localStorage.setItem("linger.sound.quietHours", "true");
    localStorage.setItem("linger.sound.quietFrom", "0");
    localStorage.setItem("linger.sound.quietUntil", "1439");
  });
  await yours.getByRole("button", { name: "Deafen" }).click();
  await expect.poll(async () => sounds(await did(page))).toEqual(["deafen"]);
});

test("with push-to-talk the voice strip keeps Mute, as the voice bar does (#232); a room you're not in voice in has no controls (#216)", async ({ page }) => {
  await open(page, "room=r-general&ptt");
  const yours = page.getByRole("group", { name: "Your voice" });
  // The key doesn't mute, so Mute is a choice of its own.
  await expect(yours.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-pressed", "false");
  await expect(yours.getByRole("button", { name: "Deafen" })).toBeVisible();
  await expect(yours.getByRole("button", { name: "Leave voice" })).toBeVisible();

  await open(page, "room=r-listening&talking");
  await expect(page.getByRole("group", { name: "Voice in this conversation" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Your voice" })).toHaveCount(0);
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

  // The pop-out button's mirror: a symbol named Back to tabs, with no words showing (#214).
  const back = page.getByRole("button", { name: "Back to tabs" });
  await expect(back).toHaveAttribute("data-kit", "IconButton");
  await expect(back).toHaveText("");
  await page.keyboard.type(", and more");
  await back.click();
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
  // The room is opened once, at the message. Walking into the tab doesn't
  // open it again at its newest page, which would leave a gap between the two (#266).
  const reads = (await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages"));
  expect(reads).toEqual(["GET /rooms/r-general/messages?around=l0000300&limit=100 as token-1"]);
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

test("a knock from a DM says Knocked once the server has it", async ({ page }) => {
  await open(page, "room=d-jules");
  const header = page.locator(".nx-pane-head");
  await header.getByRole("button", { name: "Knock" }).click();
  await expect(header.getByRole("button", { name: "Knocked" })).toBeDisabled();
  expect(await did(page)).toContain("POST /knock as token-1");
});

test("a knock the server refuses says why in the DM's header, never Knocked, then their status comes back (#288)", async ({ page }) => {
  await page.clock.install();
  await open(page, "room=d-jules&limit");
  const header = page.locator(".nx-pane-head");
  await expect(header.locator(".nx-pane-sub")).toHaveText("speakers: finally set up");
  // Every word the button shows, from here on.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { knockWords: string[] }).knockWords = seen;
    new MutationObserver(() => {
      const words = document.querySelector(".nx-pane-head .k-button-label")?.textContent;
      if (words && seen.at(-1) !== words) seen.push(words);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await header.getByRole("button", { name: "Knock" }).click();
  await expect(header.getByRole("status")).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
  await expect(header.getByRole("button", { name: "Knock" })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { knockWords: string[] }).knockWords)).not.toContain("Knocked");
  // On one line, in the chat window at its usual width, where their status was.
  const said = header.locator(".nx-pane-sub[data-problem='yes']");
  expect(await said.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.locator("[data-kit='Tooltip']")).toHaveCount(0);
  // It goes on its own, and their status is back.
  await page.clock.fastForward(8_000);
  await expect(header.getByRole("status")).toHaveCount(0);
  await expect(header.locator(".nx-pane-sub")).toHaveText("speakers: finally set up");
});

for (const [width, query, where] of [
  [420, "", "the chat window at its narrowest"],
  [360, "&single=1", "a conversation's own window"],
] as const) {
  test(`in ${where}, a refused knock's reason is in Knock's bubble, whole, and goes on its own (#288)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.clock.install();
    if (query === "") await open(page, "room=d-jules&limit");
    else await page.goto(`/tests/fixtures/next-chat-window.html?room=d-jules&limit${query}`);
    const header = page.locator(".nx-pane-head");
    await header.getByRole("button", { name: "Knock" }).click();
    // Announced, and drawn in the bubble rather than cut in the header.
    await expect(header.getByRole("status")).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
    await expect(header.locator(".nx-pane-sub[data-problem='yes']")).toHaveCount(0);
    await expect(header.locator(".nx-pane-sub")).toHaveText("speakers: finally set up");
    const bubble = page.locator("[data-kit='Tooltip']");
    await expect(bubble).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
    const laid = await bubble.evaluate((node) => {
      const edge = node.getBoundingClientRect();
      return {
        inWindow: edge.left >= 0 && edge.right <= window.innerWidth && edge.bottom <= window.innerHeight,
        sentences: [...node.querySelectorAll(".nx-pane-sentence")].map((sentence) => {
          const words = document.createRange();
          words.selectNodeContents(sentence);
          const boxes = [...words.getClientRects()];
          return {
            lines: new Set(boxes.map((box) => Math.round(box.top))).size,
            inside: boxes.every((box) => box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5),
          };
        }),
      };
    });
    expect(laid).toEqual({ inWindow: true, sentences: [{ lines: 1, inside: true }, { lines: 1, inside: true }] });
    await expect(header.getByRole("button", { name: "Knock" })).toBeEnabled();
    await page.clock.fastForward(8_000);
    await expect(bubble).toHaveCount(0);
    await expect(header.getByRole("status")).toHaveCount(0);
  });
}

test("a DM with somebody offline keeps Knock, greyed out, saying why on hover and focus, until they're back (#288)", async ({ page }) => {
  await open(page, "room=d-jules");
  const header = page.locator(".nx-pane-head");
  await page.evaluate(() =>
    window.owner?.frame({ op: "presence.update", d: { user_id: "u-jules", state: "offline", room_id: null, away_message: null } }),
  );
  const knock = header.getByRole("button", { name: "Knock" });
  await expect(knock).toBeDisabled();
  await expect(knock).toHaveAccessibleDescription("Can't knock while Jules is offline.");
  // The pointer gets the reason.
  await knock.hover();
  await expect(page.locator("[data-kit='Tooltip']")).toHaveText("Can't knock while Jules is offline.");
  // So does the keyboard: it can be reached, and pressing it does nothing.
  await page.mouse.move(0, 0);
  await knock.focus();
  await expect(knock).toBeFocused();
  await page.keyboard.press("Enter");
  await knock.click({ force: true });
  expect(await did(page)).not.toContain("POST /knock as token-1");
  // Back online, it knocks as ever.
  await page.evaluate(() =>
    window.owner?.frame({ op: "presence.update", d: { user_id: "u-jules", state: "around", room_id: null, away_message: null } }),
  );
  await expect(knock).toBeEnabled();
  await expect(knock).not.toHaveAccessibleDescription(/offline/);
  await knock.click();
  await expect(header.getByRole("button", { name: "Knocked" })).toBeVisible();
});

test("Join asks the list window to join voice here", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Join" }).click();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "voice.join", server: SERVER, roomId: "r-general" });
});

// A start that failed in the list window reaches this window with the
// devices it asked for, which decide what the strip says (#261, #273).
test("a failed start shared by the list window says what fixes it, and Pick yours opens Settings on Sound & Voice", async ({ page }) => {
  await open(page);
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  const microphone = "the microphone wouldn't open: The requested device could not be opened.";
  await page.evaluate((problem) => window.owner?.voiceFailed("r-general", problem, { input: null, output: null }), microphone);
  // This browser isn't Windows, so it's "the default".
  await expect(strip.getByRole("alert")).toHaveText("Couldn't start voice. The default microphone wouldn't open.");
  await strip.getByRole("button", { name: "Pick yours in Settings" }).click();
  await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "settings")).toEqual([{ kind: "settings", section: "sound" }]);

  // Asked for by name, there's nothing to pick.
  await page.evaluate((problem) => window.owner?.voiceFailed("r-general", problem, { input: "USB Microphone", output: null }), microphone);
  await expect(strip.getByRole("alert")).toHaveText("Couldn't start voice. The microphone wouldn't open.");
  await expect(strip.getByRole("button", { name: "Pick yours in Settings" })).toHaveCount(0);
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

test("push-to-talk turned on or off mid-call starts or stops this window listening for the key, without rejoining (#231)", async ({ page }) => {
  await open(page, "room=r-general&talking");
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "room", server: SERVER, roomId: "r-general" });
  const talks = async () => intents(await did(page)).filter((intent) => intent.kind === "voice.talk");
  // Push-to-talk off: the key is just a key.
  await page.keyboard.down("ControlRight");
  await page.keyboard.up("ControlRight");
  await page.waitForTimeout(100);
  expect(await talks()).toEqual([]);
  // Settings turns it on while you're in the call: the key works here at once.
  await page.evaluate(() => window.owner?.pushToTalk(true));
  await expect
    .poll(async () => {
      await page.keyboard.down("ControlRight");
      await page.keyboard.up("ControlRight");
      return (await talks()).length;
    })
    .toBeGreaterThanOrEqual(2);
  expect((await talks()).slice(0, 2)).toEqual([
    { kind: "voice.talk", down: true },
    { kind: "voice.talk", down: false },
  ]);
  // And off again: the key is just a key.
  await page.evaluate(() => window.owner?.pushToTalk(false));
  await expect(page.getByRole("group", { name: "Your voice" }).getByRole("button", { name: "Mute" })).toBeVisible();
  await page.waitForTimeout(100);
  const before = (await talks()).length;
  await page.keyboard.down("ControlRight");
  await page.keyboard.up("ControlRight");
  await page.waitForTimeout(100);
  expect((await talks()).length).toBe(before);
  expect(intents(await did(page)).filter((intent) => intent.kind === "voice.join")).toEqual([]);
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
  // Keep moving the clock until the wait has run out. One jump straight after
  // loading can land before a slow engine has started waiting, and then the
  // fake clock never reaches its end (seen on CI's WebKit, 2026-09-27).
  await expect
    .poll(async () => {
      await page.clock.fastForward(1_000);
      return page.getByRole("status").textContent();
    })
    .toContain("The list window didn't answer.");
  // It was only busy.
  await page.evaluate(() => window.owner?.wake());
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("tab", { name: /#general/ })).toBeVisible();
});
