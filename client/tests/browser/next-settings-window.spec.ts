import { expect, type Page, test } from "@playwright/test";

// The Settings window with its wiring (tests/fixtures/next-settings-window.tsx):
// the real SettingsWindow, the store and the sharing code, with the desktop
// shell, the list window and the server faked in the page. The screens are
// measured in next-settings.spec.ts; this is about what the window asks
// for, of whom, and when.

test.use({ viewport: { width: 720, height: 640 } });

const SERVER = "https://good-company.example";

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-settings-window.html${query}`);
  await expect(page.getByRole("tabpanel")).toBeVisible();
  // Set up: it has reported in, in the same pass that starts listening for keys.
  await expect.poll(() => did(page)).toContain('intent:{"kind":"window","focused":true,"input":true}');
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

function intents(asked: string[]): Record<string, unknown>[] {
  return asked.filter((line) => line.startsWith("intent:")).map((line) => JSON.parse(line.slice("intent:".length)) as Record<string, unknown>);
}

const nav = (page: Page) => page.getByRole("tablist", { name: "Settings sections" });
const said = (page: Page) => page.getByRole("tabpanel").locator(".nx-set-said");

test("follows the list window and reads the server with the borrowed sign-in; a host gets Hosting", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Profile");
  await expect(nav(page)).toContainText("The Good Company");
  const asked = await did(page);
  expect(asked).toContain("GET /server as token-1");
  expect(asked).toContain("GET /invites as token-1");
});

test("a member gets no Hosting, and asks nothing of a host's lists", async ({ page }) => {
  await open(page, "?member");
  await expect(nav(page).getByRole("tab", { name: "Invites" })).toHaveCount(0);
  expect((await did(page)).some((line) => line.startsWith("GET /invites"))).toBe(false);
});

test("your name saves straight to the server, with the borrowed sign-in", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Display name" }).fill("Matthew");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(said(page).first()).toHaveText("Saved");
  expect(await did(page)).toContain("PATCH /me as token-1");
});

test("going away from Settings tells the list window, which keeps your presence", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Away message" }).fill("walking the dog");
  await page.getByRole("button", { name: "Save status" }).click();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "away", server: SERVER, message: "walking the dog" });
});

test("arrival cards are on unless turned off, kept on this computer (decision 13)", async ({ page }) => {
  await open(page, "?section=notifications");
  const cards = page.getByRole("switch", { name: "Arrival cards" });
  await expect(cards).toHaveAttribute("aria-checked", "true");
  await cards.click();
  await expect(cards).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("linger.next.arrivalCards"))).toBe("false");
});

test("a notification rule is the list window's to change, and its answer shows", async ({ page }) => {
  await open(page, "?section=notifications");
  await page.getByRole("button", { name: /^Eli:/ }).click();
  await page.getByRole("switch", { name: "Everywhere, for Eli" }).click();
  expect(await did(page)).toContain(`ask:next:notify:{"server":"${SERVER}","rule":{"target_user_id":"u-eli","room_id":null},"on":true}`);
  // The owner tells every window the new rules, and the switch shows it.
  await expect(page.getByRole("switch", { name: "Everywhere, for Eli" })).toBeChecked();

  await open(page, "?section=notifications&refuse");
  await page.getByRole("button", { name: /^Eli:/ }).click();
  await page.getByRole("switch", { name: "Everywhere, for Eli" }).click();
  await expect(said(page)).toHaveText("The server is busy.");
});

test("a password change is the list window's to make, and a wrong one says so", async ({ page }) => {
  await open(page, "?section=account");
  await page.getByLabel("Current password").fill("guess-again");
  await page.getByLabel("New password").fill("new-secret-1");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(said(page).first()).toHaveText("That isn't your current password.");
  await page.getByLabel("Current password").fill("old-secret");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(said(page).first()).toHaveText("Password changed");
  expect((await did(page)).filter((line) => line.startsWith("ask:next:password"))).toHaveLength(2);
});

test("how conversations open goes to the list window, which moves what's open", async ({ page }) => {
  await open(page, "?section=windows");
  await page.getByRole("radio", { name: /own window/ }).check();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "conversations", mode: "windows" });
});

test("interface size and plain names are saved here and take effect at once", async ({ page }) => {
  await open(page, "?section=appearance");
  // No theme or warmth to choose while the new client has one set of colors.
  await expect(page.getByRole("radio", { name: /Light/ })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Evening warmth" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Interface size" }).selectOption("125");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("linger.interface.scale"))).toBe("125");
  await expect.poll(() => did(page)).toContain("zoom:1.25");
  await page.getByRole("switch", { name: "Use plain names and message fonts" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.normalize)).toBe("true");
});

test("asked for a section while it's open, it shows that section", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.shell?.section("invites"));
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Invites");
});

test("Escape in a text box only leaves the box; Escape again closes Settings, which says it's going", async ({ page }) => {
  await open(page);
  const name = page.getByRole("textbox", { name: "Display name" });
  await name.fill("Matthe");
  await page.keyboard.press("Escape");
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue("Matthe");
  expect(await did(page)).not.toContain("window:close");
  await page.keyboard.press("Escape");
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page)).at(-1)).toEqual({ kind: "closing" });
});

test("signed out of from anywhere else, Settings closes too", async ({ page }) => {
  await open(page, "?section=account");
  await page.evaluate((server) => window.shell?.signedOut(server), SERVER);
  await expect.poll(() => did(page)).toContain("window:close");
  // It wasn't Settings that asked.
  expect(intents(await did(page))).not.toContainEqual({ kind: "signout", server: SERVER });
});

test("signing out asks the list window, and Settings closes", async ({ page }) => {
  await open(page, "?section=account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => did(page)).toContain("window:close");
  expect(intents(await did(page))).toContainEqual({ kind: "signout", server: SERVER });
});

test.describe("your servers", () => {
  const GUILD = "https://ashen-lanterns.example";
  const LISBON = "https://casa-da-ribeira.example";

  test("with one server, Account & App offers to add another, in the list window", async ({ page }) => {
    await open(page, "?section=account");
    await expect(page.getByRole("tab", { name: "Servers" })).toHaveCount(0);
    await page.getByRole("button", { name: "Add a server" }).click();
    await expect.poll(() => did(page)).toContain("window:close");
    expect(intents(await did(page))).toContainEqual({ kind: "addserver" });
  });

  test("with several, Servers lists each in your order, and moves, quiets and signs out through the list window", async ({ page }) => {
    await open(page, "?section=servers&servers");
    const list = page.getByRole("list", { name: "Your servers, in order" });
    await expect(list.getByRole("heading")).toHaveText(["The Good Company", "Ashen Lanterns", "Casa da Ribeira"]);
    // Account says where each server signs out, and it's there.
    await list.getByRole("button", { name: "Move The Good Company down" }).click();
    await expect(list.getByRole("heading")).toHaveText(["Ashen Lanterns", "The Good Company", "Casa da Ribeira"]);
    await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "serverprefs").at(-1)).toEqual({
      kind: "serverprefs",
      order: [GUILD, SERVER, LISBON],
      quiet: [],
    });
    await page.getByRole("switch", { name: "Quiet, for Casa da Ribeira" }).click();
    await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "serverprefs").at(-1)).toEqual({
      kind: "serverprefs",
      order: [GUILD, SERVER, LISBON],
      quiet: [LISBON],
    });
    await page.getByRole("button", { name: "Sign out of Ashen Lanterns" }).click();
    await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "signout", server: GUILD });
    await page.getByRole("button", { name: "Add a server" }).click();
    await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "addserver" });
  });

  test("shows the order the list window says, however it was changed", async ({ page }) => {
    await open(page, "?section=servers&servers");
    const list = page.getByRole("list", { name: "Your servers, in order" });
    await expect(list.getByRole("heading")).toHaveText(["The Good Company", "Ashen Lanterns", "Casa da Ribeira"]);
    await page.evaluate(({ first, second }) => window.shell?.prefs({ order: [first, second], quiet: [first] }), { first: LISBON, second: GUILD });
    await expect(list.getByRole("heading")).toHaveText(["Casa da Ribeira", "Ashen Lanterns", "The Good Company"]);
    await expect(page.getByRole("switch", { name: "Quiet, for Casa da Ribeira" })).toBeChecked();
  });
});

test("closing the list: keep Linger in the tray by default, or quit, told to the list window and kept", async ({ page }) => {
  await open(page, "?section=windows");
  const keep = page.getByRole("radio", { name: /Keep Linger running/ });
  await expect(keep).toBeChecked();
  await page.getByRole("radio", { name: /Quit Linger/ }).check();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "tray", on: false });
  expect(await page.evaluate(() => window.localStorage.getItem("linger.next.closeList"))).toBe("quit");
});
