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

test("DM banners are on unless turned off, kept on this computer (#291)", async ({ page }) => {
  await open(page, "?section=notifications");
  const dms = page.getByRole("switch", { name: "Banners for DMs" });
  await expect(dms).toHaveAttribute("aria-checked", "true");
  await dms.click();
  await expect(dms).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("linger.next.dmAlerts"))).toBe("false");
  await dms.click();
  expect(await page.evaluate(() => localStorage.getItem("linger.next.dmAlerts"))).toBe("true");
});

test("the sound volume is kept on this computer, and letting go plays one DM chime at that level (#234)", async ({ page }) => {
  // The page's own speakers stand in: every sound started is measured, not heard.
  await page.addInitScript(() => {
    const started: number[] = [];
    Object.assign(window, { started });
    class Speakers {
      sampleRate = 48000;
      state = "running";
      destination = {};
      async resume() {}
      createBufferSource() {
        const source = {
          buffer: null as AudioBuffer | null,
          onended: null,
          connect: () => source,
          disconnect: () => {},
          start: () => started.push(source.buffer ? source.buffer.getChannelData(0).reduce((most, value) => Math.max(most, Math.abs(value)), 0) : 0),
        };
        return source;
      }
    }
    Object.assign(window, { AudioContext: Speakers });
  });
  await open(page, "?section=sound");
  const started = () => page.evaluate(() => (window as unknown as { started: number[] }).started);
  const slider = page.getByRole("slider", { name: "Sound volume" });
  await expect(slider).toHaveAttribute("aria-valuetext", "100%");
  expect(await page.evaluate(() => localStorage.getItem("linger.sound.volume"))).toBeNull();

  await slider.fill("1");
  await expect.poll(async () => (await started()).length).toBe(1);
  await slider.focus();
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "400%");
  expect(await page.evaluate(() => localStorage.getItem("linger.sound.volume"))).toBe("4");
  await expect.poll(async () => (await started()).length).toBe(2);
  const [usual = 0, loud = 0] = await started();
  // A DM chime peaks near 0.042 as written, and four times that at 400%.
  expect(usual).toBeCloseTo(0.042, 2);
  expect(loud / usual).toBeCloseTo(4, 3);

  // At 0% nothing is started, not even Play: the next sound is the one
  // played back at 100%.
  await page.keyboard.press("Home");
  expect(await page.evaluate(() => localStorage.getItem("linger.sound.volume"))).toBe("0");
  await page.getByRole("button", { name: "Play the dm messages chime" }).click();
  await slider.fill("1");
  await expect.poll(async () => (await started()).length).toBe(3);
  expect((await started())[2]).toBeCloseTo(usual, 6);
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

test("the server's name or color saved here has the list window ask the server again, not an hour later (#536)", async ({ page }) => {
  await open(page, "?section=server");
  const told = async () => intents(await did(page)).filter((intent) => intent.kind === "serverinfo");
  expect(await told()).toEqual([]);
  await page.getByRole("group", { name: "Accent color" }).getByRole("button", { name: "teal" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(told).toEqual([{ kind: "serverinfo", server: SERVER }]);
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

test("one line per person is off to start, and turning it on saves it for the list (#197)", async ({ page }) => {
  await open(page, "?section=appearance");
  const choice = page.getByRole("switch", { name: "One line per person" });
  await expect(choice).toHaveAttribute("aria-checked", "false");
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("linger.next.peopleOneLine"))).toBe("true");
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

test.describe("starting Linger when you sign in to the computer (#228)", () => {
  const startSwitch = (page: Page) => page.getByRole("switch", { name: "Start Linger when I sign in to the computer" });
  const changes = async (page: Page) => (await did(page)).filter((line) => line.startsWith("autostart:"));

  test("is off on a fresh install, and Settings changes it only when asked", async ({ page }) => {
    await open(page, "?section=account");
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "false");
    // Opening Settings only asks the computer; nothing is registered.
    expect(await changes(page)).toEqual([]);
    await startSwitch(page).click();
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "true");
    await startSwitch(page).click();
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await changes(page)).toEqual(["autostart:true", "autostart:false"]);
  });

  test("shows what the computer has, not what was clicked", async ({ page }) => {
    await open(page, "?section=account&autostart=on");
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "true");

    // A computer that takes the change without keeping it: the switch says so.
    await open(page, "?section=account&autostart=ignores");
    await startSwitch(page).click();
    await expect.poll(() => changes(page)).toEqual(["autostart:true"]);
    await expect(startSwitch(page)).toBeEnabled();
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "false");
  });

  test("a refusal is said in plain words, and the switch stays off", async ({ page }) => {
    await open(page, "?section=account&autostart=refuse");
    await startSwitch(page).click();
    await expect(page.getByRole("tabpanel").getByRole("status").filter({ hasText: "Couldn't turn this on." })).toHaveText(
      "Couldn't turn this on. This computer didn't allow it.",
    );
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(startSwitch(page)).toBeEnabled();
    expect(await changes(page)).toEqual(["autostart:true"]);
  });

  test("on a desktop that won't start it by itself, says so and links to the line to add", async ({ page }) => {
    await open(page, "?section=account");
    await expect(page.getByText(/startup list by itself/)).toHaveCount(0);

    await open(page, "?section=account&autostart=hyprland");
    await expect(page.getByRole("tabpanel")).toContainText("Hyprland doesn't start apps from the usual startup list by itself");
    // The switch still works: the entry is there for a session that does read it.
    await startSwitch(page).click();
    await expect(startSwitch(page)).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "How to add it" }).click();
    await expect
      .poll(() => did(page))
      .toContain("open:https://github.com/itsMattGuenther/Linger/blob/main/docs/user-guide.md#starting-linger-when-you-sign-in");
  });

  test("isn't offered where the computer can't do it", async ({ page }) => {
    await open(page, "?section=account&autostart=none");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(startSwitch(page)).toHaveCount(0);
  });
});

test("push-to-talk and its key are told to the list window as they change, for the call you're in (#231)", async ({ page }) => {
  await open(page, "?section=sound");
  const told = async () => intents(await did(page)).filter((intent) => intent.kind === "voice.pushtotalk");
  await page.getByRole("switch", { name: "Push to talk" }).click();
  await expect.poll(told).toEqual([{ kind: "voice.pushtotalk", on: true, key: "ControlRight" }]);
  await page.getByRole("button", { name: "Change" }).click();
  await page.keyboard.press("AltRight");
  await expect.poll(told).toEqual([
    { kind: "voice.pushtotalk", on: true, key: "ControlRight" },
    { kind: "voice.pushtotalk", on: true, key: "AltRight" },
  ]);
  await page.getByRole("switch", { name: "Push to talk" }).click();
  await expect.poll(async () => (await told()).at(-1)).toEqual({ kind: "voice.pushtotalk", on: false, key: "AltRight" });
  // Kept on this computer as well, for the next join.
  expect(await page.evaluate(() => window.localStorage.getItem("linger.voice.pushToTalk"))).toBe("false");
  expect(await page.evaluate(() => window.localStorage.getItem("linger.voice.pushToTalkKey"))).toBe("AltRight");
});

test.describe("the server's version, for its host (#314)", () => {
  test("asks the server without the sign-in, says it's behind, and opens the host guide and the release notes", async ({ page }) => {
    await open(page, "?section=server&serverVersion=0.4.3");
    const version = page.getByRole("region", { name: "Version" });
    await expect(version).toContainText("This server runs Linger 0.4.3, and 0.4.4 is out.");
    // Health needs no account, so the borrowed sign-in isn't sent with it.
    expect(await did(page)).toContain("GET /health");
    await version.getByRole("button", { name: "How to update" }).click();
    await expect.poll(() => did(page)).toContain("open:https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#updating-the-server");
    await version.getByRole("button", { name: "What's new" }).click();
    await expect.poll(() => did(page)).toContain("open:https://github.com/itsMattGuenther/Linger/releases/tag/v0.4.4");
  });

  test("a server on the newest release says so, with nothing to press", async ({ page }) => {
    await open(page, "?section=server");
    const version = page.getByRole("region", { name: "Version" });
    await expect(version).toContainText("This server runs Linger 0.4.4, the newest.");
    await expect(version.getByRole("button")).toHaveCount(0);
  });

  test("a member's Settings never asks the server which version it runs", async ({ page }) => {
    await open(page, "?member");
    await expect.poll(() => did(page)).toContain("GET /server as token-1");
    expect((await did(page)).filter((line) => line.startsWith("GET /health"))).toEqual([]);
  });
});
