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

test("only the host is offered sign-in links: a co-host's People has no such block (#581)", async ({ page }) => {
  const signInLinks = page.getByRole("region", { name: "Sign-in Links" });
  await open(page, "?section=people");
  await expect(page.getByRole("region", { name: "Members" })).toBeVisible();
  await expect(signInLinks.getByRole("button", { name: "Make a sign-in link" })).toBeVisible();

  // Eli hosts and you're a co-host: the same People, without the block.
  await open(page, "?section=people&cohost");
  await expect(page.getByRole("region", { name: "Members" })).toBeVisible();
  await expect(signInLinks).toHaveCount(0);
});

test("your name saves straight to the server, with the borrowed sign-in", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Display name" }).fill("Matthew");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(said(page).first()).toHaveText("Saved");
  expect(await did(page)).toContain("PATCH /me as token-1");
});

test("a name that looks like somebody's here is said on the name field, and Save waits for a new one (#574)", async ({ page }) => {
  await open(page);
  const name = page.getByRole("textbox", { name: "Display name" });
  const save = page.getByRole("button", { name: "Save name" });
  await name.fill("eli");
  await save.click();

  const sentence = "Someone here already goes by a name that looks like that. Try something a little different.";
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(sentence);
  // Said once, on the field, and not again beside the button.
  await expect(page.getByRole("tabpanel").getByText(sentence)).toHaveCount(1);
  await expect(said(page).first()).not.toContainText(sentence);
  await expect(save).toBeDisabled();

  await name.fill("Matthew");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await save.click();
  await expect(said(page).first()).toHaveText("Saved");
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

test("with storage full, an Appearance choice still takes effect, and goes to the other windows (#782)", async ({ page }) => {
  await open(page, "?section=appearance&full");
  await page.getByRole("combobox", { name: "Interface size" }).selectOption("125");
  await expect.poll(() => did(page)).toContain("zoom:1.25");
  await page.getByRole("switch", { name: "Use plain names and message fonts" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.normalize)).toBe("true");
  await page.getByRole("switch", { name: "One line per person" }).click();
  const announced = async () =>
    (await did(page)).filter((line) => line.startsWith("announced:")).map((line) => JSON.parse(line.slice("announced:".length)) as unknown);
  await expect.poll(announced).toContainEqual({ scale: 125, plainNames: true, oneLine: true });
  // Nothing was written.
  expect(await page.evaluate(() => window.localStorage.getItem("linger.interface.scale"))).toBeNull();
});

test("opened after a choice storage refused, Settings shows it as the list window has it (#782)", async ({ page }) => {
  await open(page, "?section=appearance&full&listchose");
  await expect(page.getByRole("combobox", { name: "Interface size" })).toHaveValue("150");
  await expect(page.getByRole("switch", { name: "One line per person" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => did(page)).toContain("zoom:1.5");
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

  const picker = (page: Page) => page.getByRole("combobox", { name: "Server" });
  const lead = (page: Page) => page.getByRole("tabpanel").locator(".nx-set-intro");

  test("with several, Settings shows one server's you at a time, picked above its sections, and saves there (#719)", async ({ page }) => {
    await open(page, "?servers");
    await expect(picker(page)).toHaveValue(SERVER);
    await expect(picker(page).locator("option")).toHaveText(["The Good Company", "Ashen Lanterns", "Casa da Ribeira"]);
    await expect(lead(page)).toHaveText("Who you are on The Good Company. Each of your servers has its own name, status and look.");
    await expect(page.getByLabel("Display name")).toHaveValue("Matt");
    // You host The Good Company: its Hosting is there.
    await expect(nav(page)).toContainText("The Good Company");
    await expect(page.getByRole("tab", { name: "Invites" })).toBeVisible();

    await picker(page).selectOption(GUILD);
    await expect(lead(page)).toHaveText("Who you are on Ashen Lanterns. Each of your servers has its own name, status and look.");
    await expect(page.getByLabel("Display name")).toHaveValue("Lamplighter");
    await expect(page.getByLabel("Status", { exact: true })).toHaveValue("healing tonight. be nice");
    // A member there: no Hosting, and nobody asked for its host's lists.
    await expect(page.getByRole("tab", { name: "Invites" })).toHaveCount(0);
    expect((await did(page)).some((line) => line.startsWith(`GET ${GUILD}/invites`))).toBe(false);

    // What's saved goes to Ashen Lanterns, not to the first server.
    const before = (await did(page)).filter((line) => line.startsWith("PATCH /me")).length;
    await page.getByLabel("Display name").fill("Lamplighter of the Lanterns");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith(`PATCH ${GUILD}/me`))).toHaveLength(1);
    expect((await did(page)).filter((line) => line.startsWith("PATCH /me"))).toHaveLength(before);

    // Account's password and archive are Ashen Lanterns' too, and the app's own sections don't change.
    await page.getByRole("tab", { name: "Account & App" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Ashen Lanterns");
    await expect(picker(page)).toHaveValue(GUILD);
  });

  test("opened on one of your servers, or asked for one while it's open, it shows that one (#719)", async ({ page }) => {
    await open(page, `?servers&section=profile&server=${encodeURIComponent(LISBON)}`);
    await expect(picker(page)).toHaveValue(LISBON);
    await expect(lead(page)).toContainText("Casa da Ribeira");
    await expect(page.getByLabel("Status", { exact: true })).toHaveValue("saudades de tudo");

    await page.getByRole("tab", { name: "Sound & Voice" }).click();
    await page.evaluate((server) => window.shell?.section("profile", server), GUILD);
    await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Profile");
    await expect(picker(page)).toHaveValue(GUILD);
    await expect(page.getByLabel("Display name")).toHaveValue("Lamplighter");

    // Asked for a section alone, it stays on the server it shows.
    await page.evaluate(() => window.shell?.section("account"));
    await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Account & App");
    await expect(picker(page)).toHaveValue(GUILD);
  });

  test("asked for a server you aren't signed in to, it shows your first (#719)", async ({ page }) => {
    await open(page, `?servers&server=${encodeURIComponent("https://elsewhere.example")}`);
    await expect(picker(page)).toHaveValue(SERVER);
    await expect(page.getByLabel("Display name")).toHaveValue("Matt");
  });

  test("a server's save that answers after another is picked lands on its own, not the one showing (#719)", async ({ page }) => {
    await open(page, "?servers&section=server");
    await expect(page.getByRole("textbox", { name: "Server name" })).toHaveValue("The Good Company");
    // The Good Company's save waits until the test lets it answer.
    await page.evaluate((server) => {
      const inner = window.fetch;
      let answer = () => {};
      const held = new Promise<void>((settle) => (answer = settle));
      (window as unknown as { letSaveAnswer: () => void }).letSaveAnswer = () => answer();
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (init?.method === "PATCH" && url.startsWith(server) && url.endsWith("/server")) await held;
        return inner(input, init);
      };
    }, SERVER);
    await page.getByRole("textbox", { name: "Server name" }).fill("Renamed Company");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await picker(page).selectOption(GUILD);
    await page.getByRole("tab", { name: "Account & App" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toContainText("The password you sign in to Ashen Lanterns with.");
    // The save answers; the list window is told once it has.
    await page.evaluate(() => (window as unknown as { letSaveAnswer: () => void }).letSaveAnswer());
    await expect.poll(async () => intents(await did(page)).filter((intent) => intent.kind === "serverinfo")).toEqual([{ kind: "serverinfo", server: SERVER }]);
    await expect(panel).toContainText("The password you sign in to Ashen Lanterns with.");
    await expect(panel).not.toContainText("Renamed Company");
    // Back on The Good Company, its new name is there.
    await picker(page).selectOption(SERVER);
    await expect(page.getByRole("tabpanel")).toContainText("The password you sign in to Renamed Company with.");
  });

  test("Servers opens Profile on the server you choose there (#719)", async ({ page }) => {
    await open(page, "?section=servers&servers");
    const cards = page.getByRole("list", { name: "Your servers, in order" }).getByRole("listitem");
    // Each says which server, as Sign out beside it does: a screen reader hears them apart.
    await expect(cards.getByRole("button", { name: /^Edit your profile on / })).toHaveText(["Edit your profile on The Good Company", "Edit your profile on Ashen Lanterns", "Edit your profile on Casa da Ribeira"]);
    await cards.nth(1).getByRole("button", { name: "Edit your profile on Ashen Lanterns" }).click();
    await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Profile");
    await expect(picker(page)).toHaveValue(GUILD);
    await expect(page.getByLabel("Display name")).toHaveValue("Lamplighter");
  });

  test("with one server, Account & App offers to add another, in the list window", async ({ page }) => {
    await open(page, "?section=account");
    await expect(page.getByRole("tab", { name: "Servers" })).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);
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

// Restart now in Settings goes to the list window, which knows about voice and
// does the install; Settings hears how it went (#772, the #794 review), so a
// failure is said there and the button comes back.
test("Restart now goes to the list window, and Settings shows how it went (#772)", async ({ page }) => {
  await open(page, "?section=account&update");
  const updates = page.getByRole("region", { name: "Updates" });
  const restart = updates.getByRole("button", { name: "Restart now" });
  await restart.click();
  await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "update" });
  await expect(restart).toBeDisabled();
  // In voice: it waits for you to leave, and says so.
  await page.evaluate(() => window.shell?.updateSaid({ problem: null, waiting: true }));
  await expect(updates).toContainText("it waits until you've left");
  await expect(restart).toBeDisabled();
  // It didn't happen: why, and the button back to try again.
  await page.evaluate(() => window.shell?.updateSaid({ problem: "The network is down.", waiting: false }));
  await expect(updates).toContainText("The network is down.");
  await expect(restart).toBeEnabled();
});
