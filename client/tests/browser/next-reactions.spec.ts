import { expect, type Page, test } from "@playwright/test";

// Reactions in the real list window, with a conversation beside it
// (tests/fixtures/next-list-window.tsx), wired end to end (#485, SPEC §4.8):
// what you leave goes to the server escaped and comes back as a frame;
// somebody else's arrives as one and calls nobody over; a room the host turns
// them off in hides them as it happens, and shows them again when it's
// turned back on; and somebody who hid them sees none at all. How the pills
// look and the picker works is next-chat.spec.ts's.

test.use({ viewport: { width: 1120, height: 820 } });

const HOME = "https://good-company.example";

async function open(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one");
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const row = (page: Page, words: string) => page.locator(".nx-msg", { hasText: words }).last();
const pills = (page: Page, words: string) => row(page, words).locator(".nx-react-pill:not(.nx-react-add)");

/** Somebody else's reaction, as the server tells it. */
async function theyReact(page: Page, messageId: string, key: string, userIds: string[]) {
  await page.evaluate(
    ([server, d]) => window.core?.frame(server, { op: "reaction.update", d } as never),
    [HOME, { message_id: messageId, key, count: userIds.length, user_ids: userIds }] as const,
  );
}

/** #general as the server now has it, its reactions on or off. */
async function switched(page: Page, off: boolean) {
  await page.evaluate(
    ([server, off]) =>
      window.core?.frame(server, {
        op: "room.update",
        d: {
          id: "r-general",
          slug: "general",
          name: "general",
          topic: "Good company. No hurry.",
          kind: "room",
          member_ids: null,
          position: 0,
          archived_at: null,
          last_message_id: null,
          ...(off ? { reactions_off: true } : {}),
        },
      } as never),
    [HOME, off] as const,
  );
}

test("yours goes to the server escaped, and the server's word comes back as a frame", async ({ page }) => {
  await open(page);
  const message = row(page, "Found the playlist");
  const id = (await message.getAttribute("data-message")) ?? "";
  await message.hover();
  await message.getByRole("button", { name: "React to Eli's message" }).click();
  const picker = page.getByRole("dialog", { name: "React to Eli's message" });
  await picker.getByRole("searchbox", { name: "Find an emoji" }).fill("fire");
  await picker.getByRole("button", { name: "fire", exact: true }).click();
  await expect(pills(page, "Found the playlist")).toHaveCount(1);
  await expect(pills(page, "Found the playlist")).toHaveAttribute("aria-pressed", "true");
  const sent = (await did(page)).filter((line) => line.includes("/reactions/"));
  expect(sent).toEqual([`PUT ${HOME}/messages/${id}/reactions/${encodeURIComponent("🔥")}`]);
  expect(await did(page)).toContain(`react ${id} 🔥 on`);
});

test("somebody else's reaction shows, and calls nobody over", async ({ page }) => {
  await open(page);
  const id = (await row(page, "No plans, no agenda").getAttribute("data-message")) ?? "";
  const before = (await did(page)).length;
  await theyReact(page, id, "😂", ["u-jules"]);
  await expect(pills(page, "No plans, no agenda").locator(".nx-react-count")).toHaveText("1");
  await expect(pills(page, "No plans, no agenda")).toHaveAttribute("aria-pressed", "false");
  // No banner, no chime: nothing the page was asked to do but draw it.
  const after = (await did(page)).slice(before);
  expect(after.filter((line) => /notify|sound|banner|flash/i.test(line))).toEqual([]);
});

test("a room the host turns reactions off in hides them as it happens, and on again shows them", async ({ page }) => {
  await open(page);
  const id = (await row(page, "No plans, no agenda").getAttribute("data-message")) ?? "";
  await theyReact(page, id, "😂", ["u-jules"]);
  await expect(pills(page, "No plans, no agenda")).toHaveCount(1);

  await switched(page, true);
  await expect(page.locator(".nx-reactions")).toHaveCount(0);
  await row(page, "No plans, no agenda").hover();
  await expect(row(page, "No plans, no agenda").getByRole("button", { name: /^React to/ })).toHaveCount(0);

  await switched(page, false);
  await expect(pills(page, "No plans, no agenda")).toHaveCount(1);
});

test("somebody who hid reactions on this computer sees none, and no way to leave one", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("linger.next.hideReactions", "true"));
  await open(page);
  const id = (await row(page, "No plans, no agenda").getAttribute("data-message")) ?? "";
  await theyReact(page, id, "😂", ["u-jules"]);
  await row(page, "No plans, no agenda").hover();
  await expect(row(page, "No plans, no agenda").getByRole("button", { name: /^Actions for/ })).toBeVisible();
  await expect(page.locator(".nx-reactions")).toHaveCount(0);
  await expect(row(page, "No plans, no agenda").getByRole("button", { name: /^React to/ })).toHaveCount(0);
});

test("on a server from before them, there's no way to react: it would refuse", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list-window.html?one&oldreactions");
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  const message = row(page, "No plans, no agenda");
  await message.hover();
  await expect(message.getByRole("button", { name: /^Actions for/ })).toBeVisible();
  await expect(message.getByRole("button", { name: /^React to/ })).toHaveCount(0);
});
