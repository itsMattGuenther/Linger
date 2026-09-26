import { expect, type Page, test } from "@playwright/test";

// The real list window, the owner (tests/fixtures/next-list-window.tsx): the
// sign-ins restored from the keyring, a connection per server, the list with
// several servers, what's kept on this computer, knocks, and answering the
// other windows. The views are measured in next-list.spec.ts and
// next-servers.spec.ts; this is about the wiring.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const toggle = (page: Page, name: string) => section(page, name).locator(".nx-srv-toggle");
const menuButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} options` });

test("restores every saved sign-in and leaves one live connection to each server", async ({ page }) => {
  await open(page);
  await expect(section(page, "The Good Company")).toBeVisible();
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  const asked = await did(page);
  for (const server of [HOME, GUILD, LISBON]) {
    expect(asked).toContain(`POST ${server}/auth/refresh`);
    // Every open closes what was there first, and React's development mode
    // mounts twice on purpose: what counts is that the last word is an open.
    const last = asked.filter((line) => line === `connect ${server}` || line === `disconnect ${server}`).at(-1);
    expect(last).toBe(`connect ${server}`);
  }
  // Only the first starts open, even though they arrive one by one.
  await expect(toggle(page, "The Good Company")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "Ashen Lanterns")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "Casa da Ribeira")).toHaveAttribute("aria-expanded", "false");
});

test("with one server it's that server's list, as before", async ({ page }) => {
  await open(page, "?one");
  await expect(page.locator(".k-titlebar")).toContainText("The Good Company");
  await expect(page.locator(".nx-srv-toggle")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Rooms" }).locator(":scope > li")).toHaveText([/general/, /listening-room/, /weekend-plans/]);
});

test("your order and Quiet are kept on this computer, across a restart", async ({ page }) => {
  await open(page);
  await menuButton(page, "Ashen Lanterns").click();
  await page.getByRole("menuitemcheckbox", { name: "Quiet" }).click();
  await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
  await menuButton(page, "Casa da Ribeira").click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.locator(".nx-srv-name")).toHaveText(["The Good Company", "Casa da Ribeira", "Ashen Lanterns"]);

  await open(page);
  await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
  await expect(page.locator(".nx-srv-name")).toHaveText(["The Good Company", "Casa da Ribeira", "Ashen Lanterns"]);
});

test("a knock from any server lands above the list's bottom and names the server; a quiet one's too", async ({ page }) => {
  await open(page);
  await menuButton(page, "Ashen Lanterns").click();
  await page.getByRole("menuitemcheckbox", { name: "Quiet" }).click();
  await page.evaluate((server) => window.core?.frame(server, { op: "knock", d: { from_user_id: "g-rui" } } as never), GUILD);
  const card = page.locator("[data-screen='knocks'] [data-kit='Notice']");
  await expect(card).toContainText("knocked.");
  await expect(card).toContainText("Ashen Lanterns");
});

test("opening a room asks the shell for the chat window, on that server", async ({ page }) => {
  await open(page);
  await toggle(page, "Casa da Ribeira").click();
  await section(page, "Casa da Ribeira").getByRole("list", { name: /Rooms/ }).getByRole("button").first().click();
  await expect.poll(async () => (await did(page)).find((line) => line.startsWith("next_open_chat"))).toContain(`"server":"${LISBON}"`);
});

test("the gear and Ctrl+, open Settings", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.keyboard.press("Control+,");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_settings"))).toHaveLength(2);
});

test("a window that asks for a snapshot gets every server, each with a lent token", async ({ page }) => {
  await open(page);
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  await page.evaluate(() => window.core?.ask("next:snapshot", {}));
  await expect.poll(async () => (await did(page)).find((line) => line.startsWith("to chat:next:snapshot:answer")) ?? "").not.toBe("");
  const line = (await did(page)).find((one) => one.startsWith("to chat:next:snapshot:answer")) ?? "";
  const payload = JSON.parse(line.slice("to chat:next:snapshot:answer:".length)) as { answer: { servers: { server: string; lent: { token: string } }[] } };
  expect(payload.answer.servers.map((one) => one.server).sort()).toEqual([GUILD, HOME, LISBON].sort());
  for (const one of payload.answer.servers) expect(one.lent.token).toBe(`token-${one.server}`);
});

test("signing out of a server tells every window, and the rest stay signed in", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "signout", server: "https://ashen-lanterns.example" }));
  await expect(section(page, "Ashen Lanterns")).toHaveCount(0);
  await expect(section(page, "The Good Company")).toBeVisible();
  const asked = await did(page);
  expect(asked).toContain(`forget ${GUILD}`);
  expect(asked.filter((line) => line.startsWith("emit next:signedout"))).toEqual([`emit next:signedout:${JSON.stringify({ v: 1, server: GUILD })}`]);
});

test("signing out of the last server tells every window, and the list goes back to signing in", async ({ page }) => {
  await open(page, "?one");
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "signout", server: "https://good-company.example" }));
  await expect(page.locator("[data-screen='signin']")).toBeVisible();
  expect((await did(page)).filter((line) => line.startsWith("emit next:signedout"))).toEqual([`emit next:signedout:${JSON.stringify({ v: 1, server: HOME })}`]);
});

test.describe("adding a server", () => {
  test("Settings asks, and the list window shows the sign-in with a way back, keeping every server connected", async ({ page }) => {
    await open(page, "?one");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("connect ")).length).toBeGreaterThan(0);
    const before = (await did(page)).filter((line) => line.includes("connect ")).length;
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    await expect(page.getByRole("heading", { name: "Add a server." })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Server or link" })).toBeFocused();
    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await expect(page.getByRole("banner")).toContainText("The Good Company");
    // Never disconnected, or connected again, along the way.
    expect((await did(page)).filter((line) => line.includes("connect ")).length).toBe(before);
  });

  test("signing in to another server adds it to the list, below the ones you have", async ({ page }) => {
    await open(page, "?one");
    const before = (await did(page)).filter((line) => line === `disconnect ${HOME}`).length;
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    const box = page.getByRole("textbox", { name: "Server or link" });
    await box.fill("ashen-lanterns.example");
    await box.press("Enter");
    const form = page.getByRole("form", { name: "Sign in" });
    await form.getByRole("textbox", { name: "Username" }).fill("lamplighter");
    await form.getByLabel("Password").fill("porch light");
    await form.getByLabel("Password").press("Enter");
    await expect(section(page, "Ashen Lanterns")).toBeVisible();
    await expect(page.locator(".nx-srv").first()).toHaveAccessibleName("The Good Company");
    const asked = await did(page);
    expect(asked).toContain(`save ${GUILD}`);
    expect(asked.filter((line) => line === `disconnect ${HOME}`).length).toBe(before);
  });

  test("Settings' order and Quiet reach the list, and the list says what it now is", async ({ page }) => {
    await open(page);
    await page.evaluate(([guild, home, lisbon]) => window.core?.ask("next:intent", { kind: "serverprefs", order: [lisbon, guild, home], quiet: [guild] }), [GUILD, HOME, LISBON]);
    await expect.poll(async () => page.locator(".nx-srv").evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label")))).toEqual([
      "Casa da Ribeira",
      "Ashen Lanterns",
      "The Good Company",
    ]);
    await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
    const told = (await did(page)).filter((line) => line.startsWith("emit next:serverprefs")).at(-1);
    expect(told).toBe(`emit next:serverprefs:${JSON.stringify({ v: 1, prefs: { order: [LISBON, GUILD, HOME], quiet: [GUILD] } })}`);
  });
});
