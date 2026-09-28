import { expect, type Locator, type Page, test } from "@playwright/test";

// The Settings window on the prototype's evening (tests/fixtures/next-settings.tsx):
// what each section shows, that every save says how it went, the keyboard,
// and that it's built the way docs/design/system.md says at both window sizes.

test.use({ viewport: { width: 720, height: 640 } });

const SECTIONS = ["profile", "appearance", "windows", "sound", "notifications", "account", "rooms", "invites", "people", "server"] as const;

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-settings.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

/** Everything the page was asked to do, in order. */
async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const nav = (page: Page) => page.getByRole("tablist", { name: "Settings sections" });
const panel = (page: Page) => page.getByRole("tabpanel");
const said = (scope: Locator) => scope.locator(".nx-set-said");

test.describe("what's there", () => {
  test("a host sees their own sections and Hosting under the server's name, in the design's order", async ({ page }) => {
    await open(page);
    await expect(nav(page).getByRole("tab")).toHaveText(["Profile", "Appearance", "Windows", "Sound & Voice", "Notifications", "Account & App", "Rooms", "Invites", "People", "Server"]);
    await expect(nav(page)).toContainText("The Good Company");
    await expect(page.locator(".k-titlebar")).toHaveText("Settings");
  });

  test("a member never sees Hosting, and Servers shows only with several servers", async ({ page }) => {
    await open(page, "?member");
    await expect(nav(page).getByRole("tab")).toHaveText(["Profile", "Appearance", "Windows", "Sound & Voice", "Notifications", "Account & App"]);
    await expect(nav(page)).not.toContainText("Hosting");
    await open(page, "?member&servers");
    await expect(nav(page).getByRole("tab").last()).toHaveText("Servers");
  });

  test("with nothing to choose there, Windows isn't offered", async ({ page }) => {
    await open(page, "?nowindows");
    await expect(nav(page).getByRole("tab", { name: "Windows" })).toHaveCount(0);
  });

  test("opens on the section asked for, and a member asked for Hosting gets Profile", async ({ page }) => {
    await open(page, "?section=invites");
    await expect(panel(page)).toHaveAccessibleName("Invites");
    await open(page, "?section=invites&member");
    await expect(panel(page)).toHaveAccessibleName("Profile");
  });

  test("every section says what it's for, under at least one heading (their casing is checked in core/settings.test.ts)", async ({ page }) => {
    await open(page);
    for (const section of SECTIONS) {
      await open(page, `?section=${section}`);
      await expect(page.locator(".nx-set-intro")).not.toBeEmpty();
      const headings = await panel(page).locator("h3, legend").allTextContents();
      expect(headings.length, section).toBeGreaterThan(0);
    }
  });
});

test.describe("moving around", () => {
  test("the sidebar moves with the arrow keys and shows each section as it goes", async ({ page }) => {
    await open(page);
    await nav(page).getByRole("tab", { name: "Profile" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(panel(page)).toHaveAccessibleName("Appearance");
    await expect(nav(page).getByRole("tab", { name: "Appearance" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(panel(page)).toHaveAccessibleName("Server");
    await page.keyboard.press("Home");
    await expect(panel(page)).toHaveAccessibleName("Profile");
  });

  test("a section opens at its top, not where the last one was scrolled to", async ({ page }) => {
    await open(page);
    const main = page.locator(".nx-set-main");
    await main.evaluate((node) => node.scrollTo(0, node.scrollHeight));
    expect(await main.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await nav(page).getByRole("tab", { name: "Sound & Voice" }).click();
    expect(await main.evaluate((node) => node.scrollTop)).toBe(0);
  });
});

test.describe("profile", () => {
  test("a new display name saves, and says so", async ({ page }) => {
    await open(page);
    const save = page.getByRole("button", { name: "Save name" });
    await expect(save).toBeDisabled();
    await page.getByRole("textbox", { name: "Display name" }).fill("Matthew");
    await save.click();
    const block = page.getByRole("region", { name: "Who You Are" });
    await expect(said(block)).toHaveText("Saved");
    expect(await did(page)).toContain("name:Matthew");
  });

  test("a refused save says why in words and keeps what was typed", async ({ page }) => {
    await open(page, "?fail");
    await page.getByRole("textbox", { name: "Display name" }).fill("Matthew");
    await page.getByRole("button", { name: "Save name" }).click();
    const block = page.getByRole("region", { name: "Who You Are" });
    await expect(said(block)).toHaveText("The server is busy. Try again in a moment.");
    await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue("Matthew");
  });

  test("the status saves whole, and a line too long says so and can't be saved", async ({ page }) => {
    await open(page);
    const block = page.getByRole("region", { name: "Your Status" });
    await block.getByRole("textbox", { name: "Reading" }).fill("Piranesi");
    await block.getByRole("button", { name: "Save status" }).click();
    await expect(said(block)).toHaveText("Saved");
    const sent = (await did(page)).find((line) => line.startsWith("status:"));
    expect(JSON.parse(sent?.slice("status:".length) ?? "{}")).toMatchObject({ line: "fixing the porch light (the real one)", reading: "Piranesi", working_on: "a design for this app" });
    await block.getByRole("textbox", { name: "Status" }).fill("x".repeat(245));
    await expect(block.getByText("5 over")).toBeVisible();
    await expect(block.getByRole("textbox", { name: "Status" })).toHaveAttribute("aria-invalid", "true");
    await expect(block.getByRole("button", { name: "Save status" })).toBeDisabled();
  });

  test("when you're away it says so, and I'm back clears it", async ({ page }) => {
    await open(page, "?away");
    const block = page.getByRole("region", { name: "Your Status" });
    await expect(block).toContainText("You're away: walking the dog");
    await block.getByRole("button", { name: "I'm back" }).click();
    await expect(block).not.toContainText("You're away");
    const sent = (await did(page)).find((line) => line.startsWith("status:"));
    expect(JSON.parse(sent?.slice("status:".length) ?? "{}")).toMatchObject({ away_message: null });
  });

  test("a status has no picture: nothing in Profile offers one, and a save sends none (#269)", async ({ page }) => {
    // `?picture`: an older server still hands one back.
    await open(page, "?picture");
    const block = page.getByRole("region", { name: "Your Status" });
    await expect(panel(page).locator('input[type="file"]')).toHaveCount(0);
    await expect(panel(page).getByRole("img")).toHaveCount(0);
    await expect(block.getByRole("button")).toHaveText(["Save status"]);
    await expect(block).not.toContainText(/image|picture/i);
    await block.getByRole("textbox", { name: "Reading" }).fill("Piranesi");
    await block.getByRole("button", { name: "Save status" }).click();
    await expect(said(block)).toHaveText("Saved");
    const sent = (await did(page)).find((line) => line.startsWith("status:"));
    expect(JSON.parse(sent?.slice("status:".length) ?? "{}")).toMatchObject({ reading: "Piranesi", image_id: null, image_url: null });
    expect((await did(page)).filter((line) => /^(upload|drop):/.test(line))).toEqual([]);
  });

  test("a new look shows in the preview first, saves whole, and resets", async ({ page }) => {
    await open(page);
    const block = page.getByRole("region", { name: "Make Yourself at Home" });
    const preview = block.locator(".nx-set-preview .k-name");
    const before = await preview.evaluate((node) => getComputedStyle(node).fontFamily);
    await block.getByRole("group", { name: "Font" }).getByRole("button", { name: "Newsreader" }).click();
    await expect.poll(() => preview.evaluate((node) => getComputedStyle(node).fontFamily)).not.toBe(before);
    await block.getByRole("button", { name: "Reset changes" }).click();
    await expect.poll(() => preview.evaluate((node) => getComputedStyle(node).fontFamily)).toBe(before);
    await block.getByRole("group", { name: "Effect" }).getByRole("button", { name: "Glow" }).click();
    await block.getByRole("button", { name: "Two, blended" }).click();
    await block.getByRole("group", { name: "To" }).getByRole("button", { name: "teal" }).click();
    await block.getByRole("button", { name: "Save your look" }).click();
    await expect(said(block)).toHaveText("Saved");
    const sent = (await did(page)).find((line) => line.startsWith("style:"));
    expect(JSON.parse(sent?.slice("style:".length) ?? "{}")).toMatchObject({ effect: "glow", fill: { kind: "gradient", to: "teal" } });
  });
});

test.describe("this app", () => {
  test("appearance choices take effect at once", async ({ page }) => {
    await open(page, "?section=appearance");
    await page.getByRole("radio", { name: /Light/ }).check();
    await page.getByRole("combobox", { name: "Interface size" }).selectOption("150");
    await page.getByRole("switch", { name: "Use plain names and message fonts" }).click();
    expect(await did(page)).toEqual(expect.arrayContaining(["theme:light", "scale:150", "plain:true"]));
  });

  test("quiet hours show their times only while on, and every chime can be played", async ({ page }) => {
    await open(page, "?section=sound");
    await expect(page.getByRole("combobox", { name: "Quiet from" })).toHaveCount(0);
    await page.getByRole("switch", { name: "Quiet hours" }).click();
    await page.getByRole("combobox", { name: "Quiet from" }).selectOption({ label: "11:30 PM" });
    await page.getByRole("button", { name: "Play the knocks chime" }).click();
    const sounds = (await did(page)).filter((line) => line.startsWith("sound:"));
    expect(JSON.parse(sounds.at(-1)?.slice("sound:".length) ?? "{}")).toMatchObject({ quietHours: true, quietFrom: 23 * 60 + 30 });
    expect(await did(page)).toContain("play:knocks");
  });

  test("one sound volume, 100% until moved; letting go saves it and plays one chime at the new level (#234)", async ({ page }) => {
    await open(page, "?section=sound");
    const slider = page.getByRole("slider", { name: "Sound volume" });
    const row = page.getByRole("group", { name: "Sound volume" });
    await expect(slider).toHaveAttribute("aria-valuetext", "100%");
    await expect(row).toContainText("100%");
    await expect(row).toContainText("up to 400%");
    const saved = async () => (await did(page)).filter((line) => line.startsWith("sound:")).map((line) => (JSON.parse(line.slice("sound:".length)) as { volume: number }).volume);
    const played = async () => (await did(page)).filter((line) => line.startsWith("play:"));
    expect(await saved()).toEqual([]);

    // A drag saves every step and plays the sample once, when it's let go.
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    if (!box) throw new Error("no slider");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.25, y);
    await page.mouse.down();
    for (const share of [0.3, 0.35, 0.4, 0.45, 0.5]) await page.mouse.move(box.x + box.width * share, y);
    await expect.poll(async () => (await saved()).length).toBeGreaterThan(2);
    expect(await played()).toEqual([]);
    await page.mouse.up();
    await expect(slider).toHaveAttribute("aria-valuetext", "200%");
    await expect(row).toContainText("200%");
    expect((await saved()).at(-1)).toBe(2);
    expect(await played()).toEqual(["play:dms"]);

    // So does a key, once it's let go.
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuetext", "205%");
    expect((await saved()).at(-1)).toBeCloseTo(2.05, 5);
    expect(await played()).toEqual(["play:dms", "play:dms"]);

    // At 0% it says nothing will play.
    await page.keyboard.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", "0%");
    expect((await saved()).at(-1)).toBe(0);
    await expect(panel(page)).toContainText("Sound volume is at 0%, so nothing plays, previews included.");
  });

  test("a remembered microphone that isn't plugged in is shown and marked; outside the app it says where to pick", async ({ page }) => {
    await open(page, "?section=sound");
    await expect(page.getByRole("combobox", { name: "Microphone" }).locator("option:checked")).toHaveText("Headset (not plugged in)");
    await expect(page.getByRole("combobox", { name: "Speakers" }).locator("option:checked")).toHaveText("System default (Headphones)");
    await open(page, "?section=sound&devices=none");
    await expect(panel(page)).toContainText("Microphones and speakers are picked in the desktop app.");
  });

  test("push-to-talk names its key, and the key is chosen by pressing it", async ({ page }) => {
    await open(page, "?section=sound");
    await expect(page.locator("kbd")).toHaveText("Right Ctrl");
    await page.getByRole("switch", { name: "Push to talk" }).click();
    const saved = async () => {
      const voice = (await did(page)).filter((line) => line.startsWith("voice:"));
      return JSON.parse(voice.at(-1)?.slice("voice:".length) ?? "{}") as Record<string, unknown>;
    };
    expect(await saved()).toMatchObject({ pushToTalk: true });
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByRole("button", { name: "Press a key…" })).toBeVisible();
    // A key that types something is refused, and it's still listening.
    await page.keyboard.press("v");
    await expect(page.getByText("That key types something.")).toBeVisible();
    await page.keyboard.press("AltRight");
    await expect(page.locator("kbd")).toHaveText("Right Alt");
    expect(await saved()).toMatchObject({ pushToTalkKey: "AltRight" });
    await expect(page.getByText("That key types something.")).toHaveCount(0);
    // Escape leaves it as it was, and doesn't close Settings.
    await page.getByRole("button", { name: "Change" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("kbd")).toHaveText("Right Alt");
    await expect(page.getByRole("button", { name: "Change" })).toBeVisible();
  });

  test("voice goes through the server by default, and the old way is one switch away (#197)", async ({ page }) => {
    await open(page, "?section=sound");
    const through = page.getByRole("switch", { name: "Voice through the server" });
    await expect(through).toHaveAttribute("aria-checked", "true");
    await through.click();
    const voice = (await did(page)).filter((line) => line.startsWith("voice:"));
    expect(JSON.parse(voice.at(-1)?.slice("voice:".length) ?? "{}")).toMatchObject({ forwarding: false });
  });

  test("a person's notification rules open, change, and fold again with Escape", async ({ page }) => {
    await open(page, "?section=notifications");
    const jules = page.getByRole("button", { name: /^Jules: #general$/ });
    await jules.click();
    await page.getByRole("group", { name: "Rooms where Jules notifies you" }).getByRole("button", { name: "#listening-room" }).click();
    await expect(page.getByRole("button", { name: /^Jules: #general, #listening-room$/ })).toBeVisible();
    expect(await did(page)).toContain("rule:u-jules:r-listening:true");
    await page.getByRole("switch", { name: "Everywhere, for Jules" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("switch", { name: "Everywhere, for Jules" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Jules:/ })).toBeFocused();
  });

  test("account: a password change needs both boxes, the archive downloads when ready, updates link out", async ({ page }) => {
    await open(page, "?section=account");
    const change = page.getByRole("button", { name: "Change password" });
    await expect(change).toBeDisabled();
    await page.getByLabel("Current password").fill("old-password");
    await page.getByLabel("New password").fill("new-password");
    await change.click();
    await expect(said(page.getByRole("region", { name: "Password" }))).toHaveText("Password changed");
    await page.getByRole("button", { name: "Export everything" }).click();
    await page.getByRole("button", { name: "Download it" }).click();
    await page.getByRole("button", { name: "What's new" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    expect(await did(page)).toEqual(expect.arrayContaining(["password:12:12", "export", "download:https://good-company.example/exports/archive.zip", "notes:0.4.0", "signout"]));
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(panel(page)).toContainText("This is the newest version.");
  });

  test("an archive asked for too soon says when to come back", async ({ page }) => {
    await open(page, "?section=account&fail");
    await page.getByRole("button", { name: "Export everything" }).click();
    await expect(panel(page)).toContainText("You can ask again in about 50 minutes.");
  });

  test("servers move in your order, each signs out on its own, and another can be added", async ({ page }) => {
    await open(page, "?section=servers&servers");
    const names = () => page.locator(".nx-set-server-name").allTextContents();
    expect(await names()).toEqual(["The Good Company", "Night Shift", "Raid Night"]);
    await expect(page.getByRole("button", { name: "Move The Good Company up" })).toBeDisabled();
    await page.getByRole("button", { name: "Move Night Shift up" }).click();
    await expect.poll(names).toEqual(["Night Shift", "The Good Company", "Raid Night"]);
    await page.getByRole("button", { name: "Sign out of Raid Night" }).click();
    await page.getByRole("button", { name: "Add a server" }).click();
    expect(await did(page)).toEqual(expect.arrayContaining(["move-server:work:-1", "signout:raid", "add-server"]));
    await expect(page.getByRole("button", { name: "Sign out of everything" })).toHaveCount(0);
  });
});

test.describe("hosting", () => {
  test("a room is made, edited in place, and Escape backs out of an edit to its button", async ({ page }) => {
    await open(page, "?section=rooms");
    await page.getByRole("textbox", { name: "Name" }).fill("Front Porch");
    await page.getByRole("button", { name: "Make the room" }).click();
    const rooms = page.getByRole("list", { name: "Rooms" }).locator(":scope > li");
    await expect(rooms).toHaveCount(4);
    await expect(rooms.last()).toContainText("Front Porch");
    expect(await did(page)).toContain("create:front-porch:Front Porch:");
    await rooms.first().getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("group", { name: "Editing #general" }).getByRole("textbox", { name: "Name" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "Editing #general" })).toHaveCount(0);
    await expect(rooms.first().getByRole("button", { name: "Edit" })).toBeFocused();
    await rooms.first().getByRole("button", { name: "Edit" }).click();
    await page.getByRole("group", { name: "Editing #general" }).getByRole("textbox", { name: "Topic" }).fill("Pull up a chair.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(rooms.first()).toContainText("Pull up a chair.");
  });

  test("a new room's name comes first, and its slug follows the name until it's typed in (#221)", async ({ page }) => {
    await open(page, "?section=rooms");
    const block = page.getByRole("region", { name: "New Room" });
    const name = block.getByRole("textbox", { name: "Name" });
    const slug = block.getByRole("textbox", { name: "Slug" });
    const make = block.getByRole("button", { name: "Make the room" });
    await expect(block.locator(".k-field-label")).toHaveText(["Name", "Slug", "Topic"]);
    // Typing the name fills the slug in, a letter at a time.
    await name.pressSequentially("Café & Clips 📸");
    await expect(slug).toHaveValue("cafe-clips");
    // A slug typed in stays put while the name changes.
    await slug.fill("clips");
    await name.fill("Screenshots and Clips");
    await expect(slug).toHaveValue("clips");
    // Emptied, it follows the name again, and shows what it will be.
    await slug.fill("");
    await expect(slug).toHaveAttribute("placeholder", "screenshots-and-clips");
    await name.fill("Screenshots and Clips!");
    await expect(slug).toHaveValue("screenshots-and-clips");
    // Emptied and left, it fills in from the name.
    await slug.fill("");
    await name.focus();
    await expect(slug).toHaveValue("screenshots-and-clips");
    // A name with nothing a slug can use leaves it empty, says what it needs, and makes nothing.
    await name.fill("🎮🎮");
    await expect(slug).toHaveValue("");
    await expect(slug).not.toHaveAttribute("placeholder");
    await expect(block.getByText("Needs a–z or 0–9. Type a slug here.")).toBeVisible();
    await expect(slug).toHaveAccessibleDescription("Needs a–z or 0–9. Type a slug here.");
    await expect(make).toBeDisabled();
    await slug.fill("games");
    await expect(block.getByText("What people type after the #.")).toBeVisible();
    await make.click();
    await expect(said(block)).toHaveText("Made");
    expect(await did(page)).toContain("create:games:🎮🎮:");
    // Made, the form starts over, and follows again.
    await expect(name).toHaveValue("");
    await expect(slug).toHaveValue("");
    await name.fill("Weekend Walk");
    await expect(slug).toHaveValue("weekend-walk");
  });

  test("a slug the server refuses keeps what was typed, with the server's words", async ({ page }) => {
    await open(page, "?section=rooms&fail");
    const block = page.getByRole("region", { name: "New Room" });
    await block.getByRole("textbox", { name: "Name" }).fill("Porch");
    await block.getByRole("textbox", { name: "Name" }).press("Enter");
    await expect(said(block)).toHaveText("A room called #porch already exists.");
    await expect(block.getByRole("textbox", { name: "Name" })).toHaveValue("Porch");
    await expect(block.getByRole("textbox", { name: "Slug" })).toHaveValue("porch");
  });

  test("archiving asks first, starting on Keep it, and Escape keeps it", async ({ page }) => {
    await open(page, "?section=rooms");
    const rooms = page.getByRole("list", { name: "Rooms" }).locator(":scope > li");
    await rooms.nth(1).getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rooms.nth(1).getByRole("button", { name: "Archive" })).toBeFocused();
    await rooms.nth(1).getByRole("button", { name: "Archive" }).click();
    await page.getByRole("button", { name: "Yes, archive" }).click();
    await expect(rooms).toHaveCount(2);
    expect(await did(page)).toContain("archive:r-listening");
  });

  test("rooms move up and down, and the ends can't move further", async ({ page }) => {
    await open(page, "?section=rooms");
    await expect(page.getByRole("button", { name: "Move #general up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move #weekend-plans down" })).toBeDisabled();
    await page.getByRole("button", { name: "Move #general down" }).click();
    await expect(page.getByRole("list", { name: "Rooms" }).locator(":scope > li").first()).toContainText("listening-room");
  });

  test("a new invite link is made and copied, and a revoked one says so and offers nothing", async ({ page }) => {
    await open(page, "?section=invites");
    await page.getByRole("button", { name: "Five people" }).click();
    await page.getByRole("button", { name: "Never" }).click();
    await page.getByRole("button", { name: "Make a link" }).click();
    await expect(said(page.getByRole("region", { name: "New Invite" }))).toHaveText("Made, and copied");
    expect(await did(page)).toContain("invite:5:never");
    const links = page.getByRole("list", { name: "Invite links" }).locator(":scope > li");
    await expect(links.first()).toContainText("NEW3-CODE");
    await expect(links.first().getByRole("button", { name: "Copied" })).toBeVisible();
    await links.nth(1).getByRole("button", { name: "Revoke" }).click();
    await expect(links.nth(1)).toContainText("revoked");
    await expect(links.nth(1).getByRole("button")).toHaveCount(0);
  });

  test("an invite for Anyone asks for no limit (#246)", async ({ page }) => {
    await open(page, "?section=invites");
    await page.getByRole("button", { name: "Anyone" }).click();
    await page.getByRole("button", { name: "Never" }).click();
    await page.getByRole("button", { name: "Make a link" }).click();
    await expect(said(page.getByRole("region", { name: "New Invite" }))).toHaveText("Made, and copied");
    expect(await did(page)).toContain("invite:any:never");
    const links = page.getByRole("list", { name: "Invite links" }).locator(":scope > li");
    await expect(links.first()).toContainText("for any number of people");
  });

  test("removing someone asks first, names them, and they can be let back in", async ({ page }) => {
    await open(page, "?section=people");
    const members = page.getByRole("list", { name: "Members" }).locator(":scope > li");
    await expect(members.first()).toContainText("You, the host");
    await members.filter({ hasText: "Callie" }).getByRole("button", { name: "Remove from the server" }).click();
    await expect(page.getByRole("group", { name: /^Remove Callie from this server\?/ })).toBeVisible();
    await page.getByRole("button", { name: "Yes, remove" }).click();
    await expect(members.filter({ hasText: "Callie" })).toHaveCount(0);
    const removed = page.getByRole("list", { name: "Removed" }).locator(":scope > li");
    await expect(removed.filter({ hasText: "Callie" })).toHaveCount(1);
    await removed.filter({ hasText: "Rory" }).getByRole("button", { name: "Let them back in" }).click();
    await expect(members.filter({ hasText: "Rory" })).toHaveCount(1);
  });

  test("the server's name and accent save together; no accent is a choice too", async ({ page }) => {
    await open(page, "?section=server");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await page.getByRole("group", { name: "Accent color" }).getByRole("button", { name: "teal" }).click();
    await expect(page.locator(".nx-set-accent-name")).toHaveText("teal");
    await save.click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "No accent" }).click();
    await page.getByRole("textbox", { name: "Server name" }).fill("The Good Co.");
    await save.click();
    await expect.poll(() => did(page)).toEqual(expect.arrayContaining(["server:The Good Company:teal", "server:The Good Co.:none"]));
  });

  test("a save that lands while you're choosing again doesn't undo your new choice", async ({ page }) => {
    await page.clock.install();
    await open(page, "?section=server");
    await page.getByRole("group", { name: "Accent color" }).getByRole("button", { name: "teal" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Still saving: you change your mind.
    await page.getByRole("button", { name: "No accent" }).click();
    await expect(page.locator(".nx-set-accent-name")).toHaveText("No accent");
    // The first save lands.
    await page.clock.fastForward(500);
    await expect(page.locator(".nx-set-accent-name")).toHaveText("No accent");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });
});

/** Controls not 24, 32 or 40px tall, anywhere in the window. */
async function misSized(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-kit-control]")].flatMap((node) => {
      const box = node.getBoundingClientRect();
      if (box.width === 0) return [];
      return [24, 32, 40].includes(Math.round(box.height * 100) / 100) ? [] : [`${node.textContent?.trim() || node.getAttribute("aria-label")}: ${box.height}`];
    }),
  );
}

/** Text cut off without an ellipsis, or running past the window (kit.spec's rule, over Settings). */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector(".nx-set");
    if (!main) return ["no window"];
    const width = document.documentElement.clientWidth;
    for (const el of main.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1) continue;
      if (box.right > width + 1) out.push(`"${el.textContent?.trim().slice(0, 40)}" runs past the window's edge`);
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (!ownText) continue;
      const ellipsizes = !/flex|grid/.test(style.display) && style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
      if (el.scrollWidth > el.clientWidth + 1 && style.display !== "inline" && !ellipsizes) {
        out.push(`"${el.textContent?.trim().slice(0, 40)}" overflows its box without an ellipsis`);
      }
    }
    return out;
  });
}

for (const [width, height] of [
  [720, 640],
  [560, 480],
] as const) {
  test.describe(`built on the system, at ${width} by ${height}`, () => {
    test.use({ viewport: { width, height } });

    test("every control is 24, 32 or 40px tall, and nothing is cut off or runs past the edge", async ({ page }) => {
      for (const query of ["", "&long", "&servers", "&away"]) {
        for (const section of [...SECTIONS, "servers"]) {
          if (section === "servers" && query !== "&servers") continue;
          await open(page, `?section=${section}${query}`);
          expect(await misSized(page), `${section}${query}`).toEqual([]);
          expect(await clipped(page), `${section}${query}`).toEqual([]);
          expect(await page.locator(".nx-set-main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${section}${query}`).toBe(true);
        }
      }
    });

    test("starting at sign-in: on a desktop that ignores it, the note and its link sit on the section's edge", async ({ page }) => {
      await open(page, "?section=account&hyprland");
      expect(await misSized(page)).toEqual([]);
      expect(await clipped(page)).toEqual([]);
      const block = page.getByRole("region", { name: "This Computer" });
      const lefts = await Promise.all(
        [block.getByText("Start Linger when I sign in to the computer"), block.getByText(/startup list by itself/), block.getByRole("button", { name: "How to add it" }), block.getByRole("button", { name: "Sign out" })].map((part) =>
          part.evaluate((node) => Math.round(node.getBoundingClientRect().left)),
        ),
      );
      expect(new Set(lefts).size, lefts.join(", ")).toBe(1);
    });

    test("your name shows whole in the preview, with the note moving aside for it", async ({ page }) => {
      await open(page, "?section=profile");
      const name = page.locator(".nx-set-preview .k-name");
      await expect(name).toHaveText("Matt");
      expect(await name.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    });

    test("a new room's name sits before its slug: beside it while they fit, above it when not", async ({ page }) => {
      await open(page, "?section=rooms");
      const block = page.getByRole("region", { name: "New Room" });
      const name = await block.getByRole("textbox", { name: "Name" }).boundingBox();
      const slug = await block.getByRole("textbox", { name: "Slug" }).boundingBox();
      if (!name || !slug) throw new Error("the New Room fields aren't drawn");
      if (width >= 720) {
        expect(Math.round(name.y)).toBe(Math.round(slug.y));
        expect(name.x + name.width).toBeLessThan(slug.x);
      } else {
        expect(name.y + name.height).toBeLessThan(slug.y);
      }
    });

    test("labels line up: fields in a row share a top, and every row of choices starts on one edge", async ({ page }) => {
      await open(page, "?section=profile");
      const tops = await page
        .getByRole("region", { name: "Who You Are" })
        .locator(".k-field-label")
        .evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
      if (width >= 720) expect(new Set(tops).size).toBe(1);
      const starts = await page
        .getByRole("region", { name: "Make Yourself at Home" })
        .locator(".nx-set-choices")
        .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().left)));
      expect(starts.length).toBeGreaterThan(4);
      expect(new Set(starts).size).toBe(1);
    });
  });
}
