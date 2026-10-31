import { expect, type Page, test } from "@playwright/test";

// Signing in, on the real list window (tests/fixtures/next-list-window.tsx,
// `?signedout`): one box to paste into, and what's pasted decides the next
// form (parity SIGN-1…6, SIGN-9, SIGN-11). The window then becomes the list.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";

/** Linux: WebKitGTK, as the packaged app reports itself. */
const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
/** Windows: WebView2, as the packaged app reports itself. */
const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
/** The Android app's engine, which names Linux too. */
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

async function open(page: Page, query = "?one&signedout") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='signin']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const pasteBox = (page: Page) => page.getByRole("textbox", { name: "Server or link" });
const go = (page: Page) => page.getByRole("button", { name: "Continue" });

async function paste(page: Page, what: string) {
  await pasteBox(page).fill(what);
  await pasteBox(page).press("Enter");
}

test("opens on one box to paste into, ready to type, with nothing to press until there's something in it", async ({ page }) => {
  await open(page);
  await expect(pasteBox(page)).toBeFocused();
  await expect(go(page)).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Join your people." })).toBeVisible();
  // A member signs in with the address: the screen mustn't say only an invite will do (#208).
  await expect(page.getByText("Your invite, or the address of a server you're on.")).toBeVisible();
  await pasteBox(page).fill("   ");
  await expect(go(page)).toBeDisabled();
  await pasteBox(page).fill("good-company.example");
  await expect(go(page)).toBeEnabled();
});

test("something that isn't an address says so, and asks no server", async ({ page }) => {
  await open(page);
  await paste(page, "not a link");
  await expect(page.getByText("That doesn't look like a server address or a link.")).toBeVisible();
  await expect(pasteBox(page)).toHaveAttribute("aria-invalid", "true");
  expect((await did(page)).filter((line) => line.startsWith("GET"))).toEqual([]);
});

test("an address nobody answers at says so in words", async ({ page }) => {
  await open(page);
  await paste(page, "nowhere.example");
  await expect(page.getByText("Couldn't reach https://nowhere.example. Check the address and that the server is running.")).toBeVisible();
  await expect(pasteBox(page)).toHaveValue("nowhere.example");
});

test("a bare address asks the server it's there, then signs in with the username as the server keeps it", async ({ page }) => {
  await open(page);
  await paste(page, "good-company.example");
  const form = page.getByRole("form", { name: "Sign in" });
  await expect(form).toBeVisible();
  expect(await did(page)).toContain(`GET ${HOME}/health`);
  await expect(form.getByText("good-company.example")).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Username" })).toBeFocused();
  await expect(form.getByRole("button", { name: "Sign in" })).toBeDisabled();

  await form.getByRole("textbox", { name: "Username" }).fill("  Matt ");
  await form.getByLabel("Password").fill("wrong");
  await form.getByLabel("Password").press("Enter");
  await expect(form.getByRole("alert")).toHaveText("That username and password don't match.");
  // Still here, with what was typed, to try again.
  await expect(form.getByRole("textbox", { name: "Username" })).toHaveValue("  Matt ");

  await form.getByLabel("Password").fill("porch light");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const asked = await did(page);
  expect(asked).toContain(`signin ${JSON.stringify({ username: "matt", password: "porch light" })}`);
  // Kept for next time, and connected.
  expect(asked).toContain(`save ${HOME}`);
  expect(asked.filter((line) => line === `connect ${HOME}` || line === `disconnect ${HOME}`).at(-1)).toBe(`connect ${HOME}`);
});

test("an address typed with http:// reaches the server over https (#208)", async ({ page }) => {
  await open(page);
  await paste(page, "http://good-company.example");
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  const asked = (await did(page)).filter((line) => line.startsWith("GET"));
  expect(asked).toEqual([`GET ${HOME}/health`]);
});

// A server that needs a newer app than this one (#793; this copy is 0.3.6,
// and `?tooold` has Casa da Ribeira work with 0.5.4 or newer): said in the
// paste box, before any form asks for a password, whatever was pasted.
test.describe("a server that needs a newer app (#793)", () => {
  const LISBON = "https://casa-da-ribeira.example";
  const NEWER = "This server needs a newer Linger. It works with Linger 0.5.4 or newer. Update Linger, then try again.";

  for (const [what, pasted] of [
    ["its address", "casa-da-ribeira.example"],
    ["an invite to it", `${LISBON}/invite/RIBEIRA`],
    ["a sign-in link for it", `${LISBON}/sign-in/abcd2345`],
    ["its setup link", `${LISBON}/setup?token=t0k`],
  ] as const) {
    test(`${what} says so, and no form asks for a password`, async ({ page }) => {
      await open(page, "?one&signedout&tooold");
      await paste(page, pasted);
      await expect(page.getByText(NEWER)).toBeVisible();
      await expect(pasteBox(page)).toHaveAttribute("aria-invalid", "true");
      await expect(pasteBox(page)).toHaveValue(pasted);
      await expect(page.getByLabel("Password")).toHaveCount(0);
      // The one question it asks needs no sign-in, and nothing else is asked.
      expect((await did(page)).filter((line) => line.includes(LISBON))).toEqual([`GET ${LISBON}/health`]);
    });
  }

  test("a server that works with this app goes on to the form as before", async ({ page }) => {
    await open(page, "?one&signedout&tooold");
    await paste(page, `${HOME}/invite/ABCD-1234`);
    await expect(page.getByRole("form", { name: "Join" })).toBeVisible();
    expect((await did(page)).filter((line) => line.startsWith(`GET ${HOME}`))).toEqual([`GET ${HOME}/health`, `GET ${HOME}/auth/invite/ABCD-1234`]);
  });
});

test("an invite leads to joining, named for its server, and Join waits for eight characters", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/invite/ABCD-1234`);
  const form = page.getByRole("form", { name: "Join" });
  await expect(form).toBeVisible();
  await expect(form.getByText("You're joining The Good Company.", { exact: false })).toBeVisible();
  const join = form.getByRole("button", { name: "Join" });
  await form.getByRole("textbox", { name: "Username" }).fill("Jules");
  await form.getByRole("textbox", { name: "Display name" }).fill("  Jules R. ");
  await form.getByLabel("Password").fill("1234567");
  await expect(join).toBeDisabled();
  // Enter on a form that isn't ready sends nothing.
  await form.getByLabel("Password").press("Enter");
  await form.getByLabel("Password").fill("12345678");
  await expect(join).toBeEnabled();
  await join.click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const sent = (await did(page)).filter((line) => line.startsWith("signin "));
  expect(sent).toEqual([`signin ${JSON.stringify({ invite_code: "ABCD-1234", username: "jules", display_name: "Jules R.", password: "12345678" })}`]);
});

test("joining with a name that looks like somebody's already there says so on the name, and waits for a new one (#574)", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/invite/ABCD-1234`);
  const form = page.getByRole("form", { name: "Join" });
  const name = form.getByRole("textbox", { name: "Display name" });
  const join = form.getByRole("button", { name: "Join" });
  await form.getByRole("textbox", { name: "Username" }).fill("callie");
  await name.fill("MATT");
  await form.getByLabel("Password").fill("12345678");
  await join.click();

  const sentence = "Someone here already goes by a name that looks like that. Try something a little different.";
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(sentence);
  // On the name, and only there: not again under the form.
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByText(sentence)).toHaveCount(1);
  // Still joining, with everything as typed, and nothing to send until the name changes.
  await expect(form.getByRole("textbox", { name: "Username" })).toHaveValue("callie");
  await expect(join).toBeDisabled();

  await name.fill("Callie");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await expect(join).toBeEnabled();
  await join.click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const sent = (await did(page)).filter((line) => line.startsWith("signin "));
  expect(sent.map((line) => (JSON.parse(line.slice("signin ".length)) as { display_name: string }).display_name)).toEqual(["MATT", "Callie"]);
});

test("an invite opened by somebody who already has an account here leads to signing in instead, and makes nobody new", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/invite/ABCD-1234`);
  const join = page.getByRole("form", { name: "Join" });
  await expect(join).toBeVisible();
  await join.getByRole("button", { name: "Sign in" }).click();

  const form = page.getByRole("form", { name: "Sign in" });
  await expect(form).toBeVisible();
  await expect(form.getByText("The Good Company")).toBeVisible();
  await form.getByRole("textbox", { name: "Username" }).fill("matt");
  await form.getByLabel("Password").fill("porch light");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const sent = (await did(page)).filter((line) => line.startsWith("signin "));
  // A sign-in, with no invite in it: the invite is left for whoever it was for.
  expect(sent).toEqual([`signin ${JSON.stringify({ username: "matt", password: "porch light" })}`]);
});

test("a sign-in link the host made leads to a new password for its account, then the list (#581)", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/sign-in/abcd2345`);
  const form = page.getByRole("form", { name: "Choose a new password" });
  await expect(form).toBeVisible();
  await expect(form.getByText("The Good Company")).toBeVisible();
  await expect(form.getByText("Callie made this link so @matt can choose a new password.", { exact: false })).toBeVisible();
  const save = form.getByRole("button", { name: "Save and sign in" });
  await expect(form.getByLabel("New password")).toBeFocused();
  await form.getByLabel("New password").fill("1234567");
  await expect(save).toBeDisabled();
  await form.getByLabel("New password").fill("porch light");
  await save.click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const sent = (await did(page)).filter((line) => line.startsWith("signin "));
  expect(sent).toEqual([`signin ${JSON.stringify({ code: "abcd2345", new_password: "porch light" })}`]);
});

test("a used sign-in link says so, and signing in says where to get one (#581)", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/sign-in/used`);
  await expect(page.getByText("That sign-in link doesn't work any more. It works once, for a day. Ask the host for a new one.")).toBeVisible();
  await paste(page, "good-company.example");
  await expect(page.getByRole("form", { name: "Sign in" }).getByText("Forgot your password? Ask the host for a sign-in link")).toBeVisible();
});

test("a link an invite page opened Linger with waits in the box, and asks nothing until Continue (#607)", async ({ page }) => {
  const link = `${HOME}/invite/ABCD-1234`;
  await open(page, `?one&signedout&opened=${encodeURIComponent(link)}`);
  await expect(pasteBox(page)).toHaveValue(link);
  await expect(page.getByText("From the link you opened. Check the address, then Continue.")).toBeVisible();
  await expect(go(page)).toBeEnabled();
  // A page can point a browser at any link: nothing is asked of that server
  // until the person has seen the address and pressed Continue.
  expect(await did(page)).toContain("link_offered");
  expect((await did(page)).filter((line) => line.startsWith("GET"))).toEqual([]);
  await go(page).click();
  const form = page.getByRole("form", { name: "Join" });
  await expect(form.getByText("You're joining The Good Company.", { exact: false })).toBeVisible();
  // Changing the box drops the line about where it came from.
  await form.getByRole("button", { name: "Change" }).click();
  await pasteBox(page).fill("good-company.example");
  await expect(page.getByText("From the link you opened.", { exact: false })).toHaveCount(0);
});

test("a spent invite or setup link says so, and the box keeps what was pasted", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/invite/DEAD`);
  await expect(page.getByText("That invite isn't good anymore. Ask for a new one.")).toBeVisible();
  await paste(page, `${HOME}/setup?token=used`);
  await expect(page.getByText("That setup link has already been used. Restart the server for a new one.")).toBeVisible();
  await expect(pasteBox(page)).toHaveValue(`${HOME}/setup?token=used`);
});

test("a setup link leads to setting the server up, and Change goes back to the box", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/setup?token=t0k`);
  const form = page.getByRole("form", { name: "Set up this server" });
  await expect(form).toBeVisible();
  await expect(form.getByText("Whoever does becomes its host", { exact: false })).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Server name" })).toBeFocused();
  await form.getByRole("button", { name: "Change" }).click();
  await expect(pasteBox(page)).toBeVisible();

  await paste(page, `${HOME}/setup?token=t0k`);
  await form.getByRole("textbox", { name: "Server name" }).fill(" The Good Company ");
  await form.getByRole("textbox", { name: "Username" }).fill("matt");
  await form.getByRole("textbox", { name: "Display name" }).fill("Matt");
  await form.getByLabel("Password").fill("12345678");
  await form.getByLabel("Password").press("Enter");
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const sent = (await did(page)).filter((line) => line.startsWith("signin "));
  expect(sent).toEqual([
    `signin ${JSON.stringify({ token: "t0k", server_name: "The Good Company", username: "matt", display_name: "Matt", password: "12345678" })}`,
  ]);
});

test("a limit on the way in says what's happening and how long to wait, each in its own words (#538)", async ({ page }) => {
  await open(page);
  await paste(page, `${HOME}/invite/ABCD-1234`);
  const join = page.getByRole("form", { name: "Join" });
  await join.getByRole("textbox", { name: "Username" }).fill("crowd");
  await join.getByRole("textbox", { name: "Display name" }).fill("Crowd");
  await join.getByLabel("Password").fill("12345678");
  await join.getByRole("button", { name: "Join" }).click();
  const said = join.getByRole("alert");
  await expect(said).toHaveText(
    "Lots of people have joined from your network in the last hour, so this server is pausing new sign-ups from it. Try again in about 10 minutes. If your group is joining together, the host can raise this limit.",
  );
  // All of it, wrapped inside the window rather than cut off at its edge.
  expect(await said.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  // Still here with what was typed, to try again.
  await expect(join.getByRole("textbox", { name: "Username" })).toHaveValue("crowd");

  // A server that's only busy says that instead: nothing about anybody's network.
  await join.getByRole("textbox", { name: "Username" }).fill("busy");
  await join.getByRole("button", { name: "Join" }).click();
  await expect(said).toHaveText("The server is busy letting other people in. Try again in a moment.");

  await join.getByRole("button", { name: "Sign in" }).click();
  const signIn = page.getByRole("form", { name: "Sign in" });
  await signIn.getByRole("textbox", { name: "Username" }).fill("guesser");
  await signIn.getByLabel("Password").fill("porch light");
  await signIn.getByRole("button", { name: "Sign in" }).click();
  await expect(signIn.getByRole("alert")).toHaveText("Too many sign-in tries from your network in the last minute. Try again in 12 seconds.");
  await expect(page.locator("[data-screen='signin']")).toBeVisible();
});

test("while it checks, it says so and a second Enter asks nothing more", async ({ page }) => {
  await open(page, "?one&signedout&hold");
  await pasteBox(page).fill("good-company.example");
  await pasteBox(page).press("Enter");
  await expect(go(page)).toHaveAttribute("aria-busy", "true");
  await pasteBox(page).press("Enter");
  await page.evaluate(() => window.core?.release());
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  expect((await did(page)).filter((line) => line === `GET ${HOME}/health`)).toHaveLength(1);
});

test("a sign-in that ended on its own says why, first thing", async ({ page }) => {
  await open(page, "?one&revoked");
  await expect(page.getByRole("status").first()).toHaveText("good-company.example: Your saved sign-in is no longer valid. Please sign in again.");
  expect(await did(page)).toContain(`forget ${HOME}`);
});

// A computer that can't keep a sign-in says so before anybody's caught out
// (SIGN-9), in plain words (#702). The system's own text is what the fixture's
// shell hands back; it's kept on the line's tooltip, never in the sentence.
const SYSTEM_TEXT = /^Platform secure storage failure: zbus error: org\.freedesktop\.DBus\.Error\.ServiceUnknown/;
const NOT_KEPT = "Linger can't remember your sign-in on this computer, so you'll sign in each time it starts.";
const keyringLine = (page: Page) => page.locator(".nx-signin-keyring");

test.describe("on Linux, where a keyring can be turned on (#702)", () => {
  test.use({ userAgent: WEBKITGTK });

  test("a computer that can't keep a sign-in says so in plain words, and how to fix it", async ({ page }) => {
    await open(page, "?one&nokeyring");
    await expect(keyringLine(page)).toHaveText(`${NOT_KEPT} Turning on a keyring, such as GNOME Keyring or KWallet, fixes that.`);
    await expect(keyringLine(page)).toHaveAttribute("title", SYSTEM_TEXT);
    await expect(page.getByText(/secure storage|zbus|freedesktop/)).toHaveCount(0);
  });
});

test.describe("on Windows, where there's no keyring to turn on (#702)", () => {
  test.use({ userAgent: WEBVIEW2 });

  test("a computer that can't keep a sign-in says so in plain words alone", async ({ page }) => {
    await open(page, "?one&nokeyring");
    await expect(keyringLine(page)).toHaveText(NOT_KEPT);
    await expect(keyringLine(page)).toHaveAttribute("title", SYSTEM_TEXT);
  });
});

test.describe("on an Android phone, whose engine also says Linux (#702)", () => {
  test.use({ userAgent: ANDROID });

  test("a phone that can't keep a sign-in says so, with nothing about a computer's keyring", async ({ page }) => {
    await open(page, "?one&nokeyring&shell=phone");
    await expect(keyringLine(page)).toHaveText("Linger can't remember your sign-in on this phone, so you'll sign in each time it starts.");
    await expect(keyringLine(page)).toHaveAttribute("title", SYSTEM_TEXT);
  });
});

test("every form fits the list window: nothing clipped, nothing sideways, edges lined up", async ({ page }) => {
  const forms: [string, string][] = [
    ["", "Where to go"],
    ["good-company.example", "Sign in"],
    [`${HOME}/invite/ABCD`, "Join"],
    [`${HOME}/setup?token=t0k`, "Set up this server"],
  ];
  for (const [pasted, name] of forms) {
    await open(page);
    if (pasted) await paste(page, pasted);
    await expect(page.getByRole("form", { name })).toBeVisible();
    const measured = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".nx-signin-body");
      const form = document.querySelector("form");
      if (!body || !form) return null;
      const left = form.getBoundingClientRect().left;
      const right = form.getBoundingClientRect().right;
      const edges = [...form.querySelectorAll(".k-field-box, .k-field-input, button[type='submit']")].map((node) => {
        const box = (node.closest(".k-field-box") ?? node).getBoundingClientRect();
        return [Math.round(box.left - left), Math.round(right - box.right)];
      });
      // A text box scrolls what's typed in it; anything else that scrolls sideways is cut off.
      const clipped = [...form.querySelectorAll<HTMLElement>("*:not(input)")].filter(
        (node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible",
      );
      return { sideways: body.scrollWidth > body.clientWidth, edges, clipped: clipped.map((node) => node.className) };
    });
    expect(measured).not.toBeNull();
    if (!measured) return;
    expect(measured.sideways, name).toBe(false);
    expect(measured.clipped, name).toEqual([]);
    expect(measured.edges.length, name).toBeGreaterThan(1);
    for (const edge of measured.edges) expect(edge, name).toEqual([0, 0]);
  }
});
