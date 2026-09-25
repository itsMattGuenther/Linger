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
