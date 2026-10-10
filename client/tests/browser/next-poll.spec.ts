import { expect, type Locator, type Page, test } from "@playwright/test";

// Polls (#474, SPEC §4.18): `/poll` in a room's box for the host or a
// co-host, the panel it opens, a poll's card (a fill behind each choice, its
// voters' dots, the people mark past sixteen), voting, Close poll for whoever
// asked, and the quiet line a closing poll leaves. The chat window on the
// prototype's evening (tests/fixtures/next-chat.tsx), `?polls`: your open
// poll on which faction, then Eli's closed one on PvP or PvE and its line.

test.use({ viewport: { width: 780, height: 790 } });

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-chat.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("log")).toBeVisible();
  await expect(page.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|").filter((line) => line !== "");
}

const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const card = (page: Page, question: string): Locator => page.locator(".nx-poll", { hasText: question });
const FACTION = "Which faction are we rolling on WoW Forever?";
const SERVER = "PvP or PvE server?";

test("a poll is its question, a row per choice with who picked it, and when it closes", async ({ page }) => {
  await open(page, "?polls");
  const faction = card(page, FACTION);
  await faction.scrollIntoViewIfNeeded();
  await expect(faction.locator(".nx-poll-question")).toHaveText(FACTION);
  await expect(faction.locator(".nx-poll-how")).toHaveText("pick one");
  // Pick-one is a radio group; nothing of yours is picked yet.
  await expect(faction.getByRole("radiogroup", { name: FACTION })).toBeVisible();
  await expect(faction.getByRole("radio", { checked: true })).toHaveCount(0);
  // Each voter is a dot with their name on it; never a number.
  const horde = faction.locator(".nx-poll-choice", { hasText: "Horde" });
  await expect(horde.locator(".nx-poll-dot")).toHaveCount(3);
  await expect(horde.locator(".nx-poll-dot").first()).toHaveAttribute("title", "Eli");
  await expect(faction).not.toContainText(/\b\d+ votes?\b/);
  // A fill for its share: Horde has three of the five who voted.
  const widths = await horde.evaluate((row) => {
    const fill = row.querySelector(".nx-poll-fill");
    return fill ? fill.getBoundingClientRect().width / row.getBoundingClientRect().width : 0;
  });
  expect(widths).toBeGreaterThan(0.55);
  expect(widths).toBeLessThan(0.65);
  await expect(faction.locator(".nx-poll-note")).toHaveText(/^Closes on \w+\.$/);
});

test("a click votes, another moves the vote, and the same one takes it back; whoever asked votes too", async ({ page }) => {
  await open(page, "?polls");
  const faction = card(page, FACTION);
  await faction.scrollIntoViewIfNeeded();
  await faction.getByRole("radio", { name: "Horde" }).click();
  await expect(faction.getByRole("radio", { name: "Horde" })).toHaveAttribute("aria-checked", "true");
  await expect(faction.locator(".nx-poll-choice", { hasText: "Horde" }).locator(".nx-poll-dot")).toHaveCount(4);
  await faction.getByRole("radio", { name: "Alliance" }).click();
  await expect(faction.getByRole("radio", { name: "Alliance" })).toHaveAttribute("aria-checked", "true");
  await expect(faction.getByRole("radio", { name: "Horde" })).toHaveAttribute("aria-checked", "false");
  await faction.getByRole("radio", { name: "Alliance" }).click();
  await expect(faction.getByRole("radio", { checked: true })).toHaveCount(0);
  const votes = (await did(page)).filter((line) => line.startsWith("vote:"));
  expect(votes.map((line) => line.split(":").at(-1))).toEqual(["0", "1", ""]);
});

test("past sixteen voters, the people mark lists everybody who picked it", async ({ page }) => {
  await open(page, "?polls&raid");
  const horde = card(page, FACTION).locator(".nx-poll-choice", { hasText: "Horde" });
  await horde.scrollIntoViewIfNeeded();
  await expect(horde.locator(".nx-poll-dot")).toHaveCount(16);
  // One row still: the dots never push onto a second line.
  const row = await horde.boundingBox();
  expect(row?.height).toBeLessThanOrEqual(34);
  await horde.getByRole("button", { name: "Everyone who picked Horde" }).click();
  const everyone = page.getByRole("dialog", { name: "Everyone who picked Horde" });
  await expect(everyone).toBeVisible();
  await expect(everyone.getByRole("listitem")).toHaveCount(33);
  await page.keyboard.press("Escape");
  await expect(everyone).toBeHidden();
});

test("only whoever asked can close it, and closed it has no boxes and its winner in bold", async ({ page }) => {
  await open(page, "?polls");
  const faction = card(page, FACTION);
  const server = card(page, SERVER);
  await server.scrollIntoViewIfNeeded();
  // Eli asked this one, and it's closed: no boxes, nothing to press.
  await expect(server.locator(".nx-poll-how")).toHaveText("closed");
  await expect(server.getByRole("radio")).toHaveCount(0);
  await expect(server.getByRole("button", { name: "Close poll" })).toHaveCount(0);
  await expect(server.locator(".nx-poll-note")).toHaveText(/^Closed by Eli at /);
  const weight = await server
    .locator(".nx-poll-choice", { hasText: "PvE" })
    .evaluate((row) => Number(getComputedStyle(row).fontWeight));
  expect(weight).toBe(600);

  // You asked this one.
  await faction.scrollIntoViewIfNeeded();
  await faction.getByRole("button", { name: "Close poll" }).click();
  await expect(faction.locator(".nx-poll-how")).toHaveText("closed");
  await expect(faction.locator(".nx-poll-note")).toHaveText(/^Closed by Matt at /);
  expect((await did(page)).some((line) => line.startsWith("close:"))).toBe(true);
});

test("a closed poll leaves a quiet line, and See results goes up to it", async ({ page }) => {
  await open(page, "?polls");
  const line = page.locator("[data-poll-closed]");
  await expect(line.locator(".nx-quiet-words")).toHaveText("Poll closed: “PvP or PvE server?” PvE won. See results");
  // As quiet as somebody joining voice.
  const muted = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-muted)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(await line.locator(".nx-quiet-words").evaluate((node) => getComputedStyle(node).color)).toBe(muted);
  await line.getByRole("button", { name: "See results" }).click();
  await expect(page.locator(".nx-msg", { hasText: SERVER })).toHaveAttribute("data-flash", "yes");
});

test("/poll says what it does, opens the panel with the question, and Post poll asks it", async ({ page }) => {
  await open(page, "?polls");
  await box(page).click();
  await box(page).pressSequentially("/poll Which nights work for raiding?");
  await expect(page.locator(".nx-composer-command")).toHaveText("/pollAsks #general a question. Enter opens it, so you can add the choices.");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("group", { name: "New poll in #general" });
  await expect(panel).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await expect(panel.getByRole("textbox", { name: "Question" })).toHaveValue("Which nights work for raiding?");
  // Not ready without two choices, and it says why.
  await expect(panel.getByRole("button", { name: /Post poll/ })).toHaveAttribute("aria-disabled", "true");
  await expect(panel).toContainText("A poll needs at least 2 choices.");
  // Typing straight on: the first choice has the keyboard, Enter moves down and adds.
  await page.keyboard.type("Tuesday");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Thursday");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sunday");
  await expect(panel.getByRole("textbox", { name: "Choice 3" })).toHaveValue("Sunday");
  await panel.getByRole("switch", { name: "People can pick more than one" }).click();
  await panel.getByRole("combobox", { name: "Closes after" }).selectOption("14");
  await panel.getByRole("button", { name: "Post poll" }).click();
  await expect(panel).toBeHidden();
  const asked = (await did(page)).find((line) => line.startsWith("poll:"));
  expect(JSON.parse(asked?.slice("poll:".length) ?? "{}")).toEqual({
    question: "Which nights work for raiding?",
    choices: ["Tuesday", "Thursday", "Sunday"],
    multi: true,
    closes_in_days: 14,
  });
});

test("Escape puts the panel away", async ({ page }) => {
  await open(page, "?polls");
  await box(page).click();
  await box(page).pressSequentially("/poll");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("group", { name: "New poll in #general" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(box(page)).toBeFocused();
});

test("somebody who isn't the host or a co-host is told who can, and keeps their words", async ({ page }) => {
  await open(page, "?polls&member");
  await box(page).click();
  await box(page).pressSequentially("/poll Which night?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".nx-composer-command")).toHaveText("/pollOnly the host or a co-host can start a poll.");
  await expect(box(page)).toHaveValue("/poll Which night?");
  await expect(page.getByRole("group", { name: /New poll/ })).toHaveCount(0);
  expect((await did(page)).some((line) => line.startsWith("poll:") || line.startsWith("send:"))).toBe(false);
});
