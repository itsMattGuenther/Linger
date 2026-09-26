import { expect, type Page, test } from "@playwright/test";

// Signing in, on the real list window (tests/fixtures/next-list-window.tsx,
// `?signedout`): one box to paste into, and what's pasted decides the next
// form (parity SIGN-1…6, SIGN-9, SIGN-11). The window then becomes the list.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";

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

test("a computer that can't keep a sign-in says so before anybody's caught out", async ({ page }) => {
  await open(page, "?one&nokeyring");
  await expect(page.getByText("No usable keyring on this computer (no secret service). You'll have to sign in again next time.")).toBeVisible();
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
