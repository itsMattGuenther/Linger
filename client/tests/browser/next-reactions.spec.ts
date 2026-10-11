import { expect, type Locator, type Page, test } from "@playwright/test";

// Reactions in the real list window, with a conversation beside it
// (tests/fixtures/next-list-window.tsx), wired end to end (#485, SPEC §4.8):
// what you leave goes to the server escaped and comes back as a frame;
// somebody else's arrives as one and calls nobody over; a room the host turns
// them off in hides them as it happens, and shows them again when it's
// turned back on; and somebody who hid them sees none at all. On a phone, a
// pill held lists who left it (#573). How the pills look and the picker
// works is next-chat.spec.ts's.

test.use({ viewport: { width: 1120, height: 820 } });

const HOME = "https://good-company.example";

async function open(page: Page, query = "?one") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
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

// Held on a phone (#573): there's no pointer to hover a pill with, so holding
// one lists everybody who left it, by name, as Discord does. A tap still adds
// yours, and a finger that moves is scrolling the conversation. The finger is
// Chromium's own touch input, held down and moved through the DevTools
// protocol, which only Chromium has; the phone's engine is Chromium too
// (Android's WebView).
test.describe("held on a phone", () => {
  test.use({ viewport: { width: 411, height: 914 }, hasTouch: true });
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test hold a finger down, and the phone's engine is Chromium");

  /** A finger on the screen. */
  async function finger(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at ? [at] : [] });
    return {
      down: (at: { x: number; y: number }) => send("touchStart", at),
      move: (at: { x: number; y: number }) => send("touchMove", at),
      up: () => send("touchEnd"),
    };
  }

  async function middle(of: Locator): Promise<{ x: number; y: number }> {
    const box = await of.boundingBox();
    if (!box) throw new Error("not on the screen");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  const who = (page: Page) => page.getByRole("dialog", { name: "Everyone who reacted with 😂" });
  const reacted = async (page: Page, since: number) => (await did(page)).slice(since).filter((line) => line.startsWith("react "));

  test("holding a pill lists who left it, by name, and leaves yours as it was", async ({ page }) => {
    await open(page, "?one&shell=phone");
    const id = (await row(page, "No plans, no agenda").getAttribute("data-message")) ?? "";
    await theyReact(page, id, "😂", ["u-jules", "u-dave"]);
    const pill = pills(page, "No plans, no agenda");
    // A screen reader hears who from the pill itself, held or not.
    await expect(pill).toHaveAttribute("aria-label", "😂 2. Jules and Dave reacted.");
    const before = (await did(page)).length;
    const touch = await finger(page);

    await touch.down(await middle(pill));
    // It opens while the finger is still down, as Discord's does.
    await expect(who(page)).toBeVisible();
    await touch.up();
    await expect(who(page).getByRole("listitem")).toHaveText(["Jules", "Dave"]);
    // Holding a pill isn't holding its message: no sheet of the message's actions.
    await expect(page.getByRole("menu")).toHaveCount(0);
    // And it wasn't a tap: nothing of yours was added.
    await expect(pill).toHaveAttribute("aria-pressed", "false");
    await expect(pill.locator(".nx-react-count")).toHaveText("2");
    expect(await reacted(page, before)).toEqual([]);
    // Over the pill, on the screen.
    const card = await who(page).boundingBox();
    const under = await pill.boundingBox();
    expect(card && under && card.y + card.height).toBeLessThanOrEqual((under?.y ?? 0) + 1);
    expect(card && card.y).toBeGreaterThanOrEqual(0);
    // It has the keyboard, and Escape gives it back to the pill.
    await expect(who(page).getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(who(page)).toHaveCount(0);
    await expect(pill).toBeFocused();
    await expect(page.locator("[data-screen='chat']")).toBeVisible();

    // Held again, a tap anywhere else closes it, and still nothing is added.
    await touch.down(await middle(pill));
    await expect(who(page)).toBeVisible();
    await touch.up();
    await row(page, "Count me in").locator(".nx-msg-body").tap();
    await expect(who(page)).toHaveCount(0);
    expect(await reacted(page, before)).toEqual([]);

    // The phone's own long-press on a pill, which Android sends while the
    // finger is down, is the same hold: who, not the message's sheet.
    await pill.dispatchEvent("contextmenu");
    await expect(who(page)).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("a tap still adds yours, and a finger that moves is a scroll, which opens nothing", async ({ page }) => {
    await open(page, "?one&shell=phone");
    const id = (await row(page, "No plans, no agenda").getAttribute("data-message")) ?? "";
    await theyReact(page, id, "😂", ["u-jules"]);
    const pill = pills(page, "No plans, no agenda");
    await expect(pill).toHaveAttribute("aria-pressed", "false");
    let before = (await did(page)).length;

    await pill.tap();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => reacted(page, before)).toEqual([`react ${id} 😂 on`]);
    await expect(who(page)).toHaveCount(0);

    // Down on the pill and away up the screen, for longer than a hold.
    before = (await did(page)).length;
    const touch = await finger(page);
    const at = await middle(pill);
    await touch.down(at);
    for (let step = 1; step <= 6; step += 1) await touch.move({ x: at.x, y: at.y - step * 8 });
    // Give it the chance to be wrong.
    await page.waitForTimeout(800);
    await touch.up();
    await expect(who(page)).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    expect(await reacted(page, before)).toEqual([]);

    // A second tap takes yours back. (The stand-in server only knows of
    // yours, so its word back takes the pill away; the request is the test.)
    await pill.tap();
    await expect.poll(() => reacted(page, before)).toEqual([`react ${id} 😂 off`]);
  });
});
