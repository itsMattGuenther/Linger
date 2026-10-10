import { expect, type Locator, type Page, test } from "@playwright/test";
import { still } from "./still";

// The buddy list window on the prototype's Friday evening
// (tests/fixtures/next-list.tsx). What it shows, that it is built the way
// docs/design/system.md says, and that it can be used without a mouse.

test.use({ viewport: { width: 340, height: 820 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html");
  await page.evaluate(() => document.fonts.ready);
});

async function boxes(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
}

function rows(page: Page, list: string): Locator {
  return page.getByRole("list", { name: list }).locator(":scope > li");
}

/**
 * Somebody's card, from the button their row shows on hover (#351): a click
 * on the row itself opens them beside the list.
 */
async function openCard(page: Page, list: string, name: string) {
  const row = rows(page, list).filter({ hasText: name });
  await row.hover();
  await row.getByRole("button", { name: `${name}'s card` }).click();
}

/** The same from the keyboard: their row, Tab to its card button, Enter. */
async function openCardByKeyboard(page: Page, list: string, name: string) {
  await rows(page, list).filter({ hasText: name }).getByRole("button").first().focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
}

/**
 * Hover a control and check its tooltip is drawn whole: inside the window and
 * on top of everything at its middle and corners (#140).
 */
async function expectWholeTooltip(page: Page, control: Locator, name: string) {
  await control.hover();
  const tip = page.locator("[data-kit='Tooltip']");
  await expect(tip).toHaveText(name);
  await expect(tip).toHaveAttribute("data-placed", "yes");
  const whole = await tip.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const inset = 2;
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ] as const;
    // A tooltip ignores the pointer, which hides it from elementFromPoint
    // too; let it be seen just for the check.
    const bubble = node as HTMLElement;
    bubble.style.pointerEvents = "auto";
    const onTop = points.every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
    bubble.style.pointerEvents = "";
    return { inWindow: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, onTop };
  });
  expect(whole, name).toEqual({ inWindow: true, onTop: true });
  await page.mouse.move(1, 1);
  await expect(tip).toHaveCount(0);
}

test("shows the server, you, and the rooms in their order", async ({ page }) => {
  await expect(page.locator(".k-titlebar")).toContainText("The Good Company");
  const you = page.getByRole("region", { name: "You" });
  await expect(you).toContainText("Matt");
  await expect(you).toContainText("in #general");
  await expect(you).toContainText("fixing the porch light (the real one)");
  // Your group DMs come after the rooms: small private rooms (#351).
  await expect(rows(page, "Rooms")).toHaveText([/general/, /listening-room/, /weekend-plans/, /Eli and Sam/]);
});

test("makes a room bold only when it holds something new, and never shows a number", async ({ page }) => {
  const weights = await rows(page, "Rooms").evaluateAll((items) =>
    items.map((item) => {
      const title = item.querySelector(".k-row-title");
      return title ? Number(getComputedStyle(title).fontWeight) : 0;
    }),
  );
  const [general, listening, plans] = weights;
  expect(general).toBeLessThan(600);
  expect(listening).toBeGreaterThanOrEqual(600);
  expect(plans).toBeGreaterThanOrEqual(600);
  // Nothing in the list is a bare number: no counts, anywhere (AGENTS rule 3).
  const numeric = await page.locator(".nx-list *").evaluateAll((elements) =>
    elements.filter((element) => element.children.length === 0 && /^\s*\d+\s*$/.test(element.textContent ?? "")).length,
  );
  expect(numeric).toBe(0);
});

test("draws every room's # the same, fresh or not", async ({ page }) => {
  const colors = await page.locator(".nx-list [data-kit='HashMark'], .nx-list .k-hash").evaluateAll((marks) =>
    marks.map((mark) => getComputedStyle(mark).color),
  );
  expect(colors.length).toBe(3);
  expect(new Set(colors).size).toBe(1);
});

// A DM is addressed to you, so one you haven't read is lit in the lamp, not
// only bold (#291). Rooms stay bold only. A one-to-one DM lives on its
// person's row, and a group DM's row sits with the rooms (#351).
test("somebody who wrote to you is lit on their row, a group DM on its own, rooms are only bold, and reading puts it out (#291, #351)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?live");
  await expect(page.locator("body")).toHaveAttribute("data-live", "ready");
  type Live = { said: (roomId: string, authorId: string) => void; read: (roomId: string) => void };
  const live = (act: (linger: Live) => void) => page.evaluate(`(${act.toString()})(window.linger)`);
  const look = (row: Locator) =>
    row.evaluate((item) => {
      const main = item.querySelector(".k-row-main");
      const title = item.querySelector(".k-row-title");
      const style = main ? getComputedStyle(main) : null;
      return { background: style?.backgroundColor ?? "", edge: style?.boxShadow ?? "", weight: title ? Number(getComputedStyle(title).fontWeight) : 0 };
    });
  const jules = rows(page, "People here").filter({ hasText: "Jules" });
  const dave = rows(page, "People here").filter({ hasText: "Dave" });
  const both = rows(page, "Rooms").filter({ hasText: "Eli and Sam" });
  await expect(jules).toHaveAttribute("data-lit", "yes");
  await expect(dave).not.toHaveAttribute("data-lit", "yes");
  await expect(both).not.toHaveAttribute("data-lit", "yes");
  // Said in words for a screen reader too, never a count.
  await expect(jules.getByRole("button").first()).toHaveAccessibleName(/wrote to you/);
  const [lit, plain] = [await look(jules), await look(dave)];
  // Drawn, not only marked: a fill and an edge the unread one alone has.
  // Their name keeps the face and weight they chose; the light says it.
  expect(lit.background).not.toBe(plain.background);
  expect(lit.edge).not.toBe("none");
  expect(plain.edge).toBe("none");
  // Rooms with something new are bold, never lit.
  await expect(rows(page, "Rooms").and(page.locator("[data-lit='yes']"))).toHaveCount(0);
  await expect(rows(page, "Rooms").and(page.locator("[data-fresh='yes']"))).toHaveCount(2);
  // Hovered, it stays lit.
  await jules.hover();
  expect((await look(jules)).edge).not.toBe("none");
  // Read, it goes out; somebody writing in the group lights that row, and bold.
  await live((linger) => linger.read("d-jules"));
  await expect(jules).not.toHaveAttribute("data-lit", "yes");
  await live((linger) => linger.said("d-eli-sam", "u-eli"));
  await expect(both).toHaveAttribute("data-lit", "yes");
  expect((await look(both)).weight).toBeGreaterThanOrEqual(600);
});

test("a folded People heading is lit while somebody inside has written to you, and a folded Rooms heading while a group DM has (#291, #351)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?live");
  await expect(page.locator("body")).toHaveAttribute("data-live", "ready");
  const heading = page.locator(".k-section", { hasText: /^People/ });
  const rooms = page.locator(".k-section", { hasText: /^Rooms/ });
  // Open, the rows show it and the heading stays plain.
  await expect(heading).not.toHaveAttribute("data-lit", "yes");
  await heading.getByRole("button", { name: /People/ }).click();
  await expect(heading).toHaveAttribute("data-lit", "yes");
  const [lit, plain] = await Promise.all([heading, rooms].map((one) => one.evaluate((node) => getComputedStyle(node).backgroundColor)));
  expect(lit).not.toBe(plain);
  // Its "show" stays readable on the lamp: not the muted grey (contrast.test.ts).
  const hint = await heading.locator(".k-section-hint").evaluate((node) => getComputedStyle(node).color);
  const muted = await rooms.locator(".k-section-text").evaluate((node) => getComputedStyle(node).color);
  expect(hint).not.toBe(muted);
  // Read while folded, it goes out.
  await page.evaluate(`window.linger.read("d-jules")`);
  await expect(heading).not.toHaveAttribute("data-lit", "yes");
  // Rooms, folded, lights for a group DM written in, and not for a room.
  await rooms.getByRole("button", { name: /Rooms/ }).click();
  await expect(rooms).not.toHaveAttribute("data-lit", "yes");
  await page.evaluate(`window.linger.said("d-eli-sam", "u-sam")`);
  await expect(rooms).toHaveAttribute("data-lit", "yes");
});

test("has no DMs section: a one-to-one DM lives on its person's row, and a group DM with the rooms (#351)", async ({ page }) => {
  await expect(page.getByRole("list", { name: "DMs" })).toHaveCount(0);
  await expect(page.locator(".k-section", { hasText: /^DMs/ })).toHaveCount(0);
  await expect(page.locator(".k-section-text")).toHaveText(["Rooms", "People", "Away", "Offline"]);
  await expect(rows(page, "Rooms").last()).toHaveText(/Eli and Sam/);
  await expect(rows(page, "People here").first()).toHaveText(/Jules/);
});

// The people you're talking to come first in each group (#351): whoever
// wrote to you, then whoever you talked with most recently, then everyone
// else. Live, as DMs have been since #248: never the order at connect.
test("the people you're talking to come first: whoever wrote, then the latest talked with, then everyone else (#351)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?live&talked");
  await expect(page.locator("body")).toHaveAttribute("data-live", "ready");
  type Live = { said: (roomId: string, authorId: string) => void; read: (roomId: string) => void };
  const live = (act: (linger: Live) => void) => page.evaluate(`(${act.toString()})(window.linger)`);
  const here = rows(page, "People here");
  // Jules wrote and it's unread; Dave was talked with; Eli and Callie weren't.
  await expect(here).toHaveText([/Jules/, /Dave/, /Eli/, /Callie/]);
  // Read, Jules stays up: he's the one talked with most recently.
  await live((linger) => linger.read("d-jules"));
  await expect(here).toHaveText([/Jules/, /Dave/, /Eli/, /Callie/]);
  // Dave writes: he's first, and stays first once read.
  await live((linger) => linger.said("d-dave", "u-dave"));
  await expect(here).toHaveText([/Dave/, /Jules/, /Eli/, /Callie/]);
  await live((linger) => linger.read("d-dave"));
  await expect(here).toHaveText([/Dave/, /Jules/, /Eli/, /Callie/]);
  // You write to Jules: he's the latest talked with again.
  await live((linger) => {
    linger.said("d-jules", "u-matt");
    linger.read("d-jules");
  });
  await expect(here).toHaveText([/Jules/, /Dave/, /Eli/, /Callie/]);
});

test("somebody who writes shows even in a folded group, lit, and the rest of it stays folded (#351)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?live&talked");
  await expect(page.locator("body")).toHaveAttribute("data-live", "ready");
  const offline = page.getByRole("button", { name: /Offline/ });
  await expect(offline).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("list", { name: "Offline" })).toHaveCount(0);
  await page.evaluate(`window.linger.said("d-jen", "u-jen")`);
  await expect(rows(page, "Offline")).toHaveText([/Jen/]);
  await expect(rows(page, "Offline").first()).toHaveAttribute("data-lit", "yes");
  await expect(offline).toHaveAttribute("aria-expanded", "false");
  // Read, it folds away with the rest.
  await page.evaluate(`window.linger.read("d-jen")`);
  await expect(page.getByRole("list", { name: "Offline" })).toHaveCount(0);
});

// The lights off (#301): idle is their dot at half strength and a grey name,
// with idle in words. The dot sits where every dot sits, whether or not
// there's a status line under the name: the 💤 used to be lifted to the
// name's line, which put it above the name in a row with nothing under it.
test("somebody idle is a half-strength dot and a grey name, says idle in words, and the dot sits where any dot does (#301)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?idle=many");
  await page.evaluate(() => document.fonts.ready);
  const here = rows(page, "People here");
  // Callie has no status line; Dave has one; Jules is around, with one.
  for (const who of ["Callie", "Dave"]) {
    const row = here.filter({ hasText: who });
    await expect(row.locator('[data-kit="Marker"]')).toHaveAttribute("data-state", "idle");
    await expect(row.locator('[data-kit="Marker"] svg')).toHaveCount(0);
    await expect(row.locator('[data-kit="Name"]')).toHaveAttribute("data-dim", "yes");
    await expect(row).toContainText("idle");
  }
  await expect(here.filter({ hasText: "Jules" }).locator('[data-kit="Name"]')).not.toHaveAttribute("data-dim", "yes");
  const placed = (who: string) =>
    here.filter({ hasText: who }).evaluate((row) => {
      const dot = row.querySelector('[data-kit="Marker"]')?.getBoundingClientRect();
      const title = row.querySelector(".k-row-title");
      const box = row.getBoundingClientRect();
      if (!dot || !title) return null;
      const range = document.createRange();
      range.selectNodeContents(title);
      const name = range.getBoundingClientRect();
      return { x: dot.x - box.x, fromMiddle: dot.y + dot.height / 2 - (box.y + box.height / 2), offName: Math.abs(dot.y + dot.height / 2 - (name.y + name.height / 2)) };
    });
  const [callie, dave, jules] = [await placed("Callie"), await placed("Dave"), await placed("Jules")];
  // With nothing under the name, the dot is level with it.
  expect(callie?.offName ?? Infinity).toBeLessThanOrEqual(1);
  // With a status line, it's where the around person's dot is.
  expect(Math.abs((dave?.fromMiddle ?? Infinity) - (jules?.fromMiddle ?? 0))).toBeLessThanOrEqual(0.5);
  // And every dot is in the same column.
  expect(new Set([callie?.x, dave?.x, jules?.x].map((x) => Math.round(x ?? -1))).size).toBe(1);
});

test("somebody away is a grey name and a half-strength moon, with their away message warm; your own card stays lit (#301)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?away");
  await page.evaluate(() => document.fonts.ready);
  const sam = rows(page, "Away").filter({ hasText: "Sam" });
  await expect(sam.locator('[data-kit="Marker"]')).toHaveAttribute("data-state", "away");
  await expect(sam.locator('[data-kit="Name"]')).toHaveAttribute("data-dim", "yes");
  expect(await sam.locator('[data-kit="Marker"]').evaluate((node) => getComputedStyle(node).opacity)).toBe("0.5");
  const warm = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ink-warm").trim());
  const note = await sam.locator(".k-row-detail").evaluate((node) => getComputedStyle(node).color);
  expect(note).toBe(await page.evaluate((hex) => {
    const probe = document.createElement("span");
    probe.style.color = hex;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, warm));
  // You're away here too (`?away`), and your own name at the top stays lit.
  await expect(page.getByRole("region", { name: "You" }).locator('[data-kit="Name"]').first()).not.toHaveAttribute("data-dim", "yes");
});

test("with no DMs yet, the + for a group is on Rooms and People is everyone, as ever (#351)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?nodms");
  await expect(page.getByRole("button", { name: "Start a group" })).toBeVisible();
  await expect(rows(page, "Rooms")).toHaveText([/general/, /listening-room/, /weekend-plans/]);
  await expect(rows(page, "People here").and(page.locator("[data-lit='yes']"))).toHaveCount(0);
});

test("a brand-new server says so in each empty place, and the host gets a way to fill it (decision 17)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?bare");
  await expect(page.locator("#nx-rooms .nx-list-empty")).toHaveText("No rooms yet.");
  await expect(page.locator("#nx-people .nx-list-empty")).toHaveText("Nobody else is here yet.");
  await page.getByRole("button", { name: "Make the first room" }).click();
  await page.getByRole("button", { name: "Invite people" }).click();
  expect(await page.evaluate(() => document.body.dataset.opened)).toBe("host:rooms,host:invites");
  // The button starts on the same edge as the words above it.
  const words = await page.locator("#nx-rooms .nx-list-empty").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left;
  });
  const button = await page.getByRole("button", { name: "Make the first room" }).boundingBox();
  expect(Math.abs((button?.x ?? 0) - words)).toBeLessThan(1);
  // Somebody who isn't the host just reads the lines.
  await page.goto("/tests/fixtures/next-list.html?bare&member");
  await expect(page.locator("#nx-rooms .nx-list-empty")).toHaveText("No rooms yet.");
  await expect(page.getByRole("button", { name: "Make the first room" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
});

test("past eight rooms, the quiet ones fold under More rooms, with no number (decision 22)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?many");
  const shown = rows(page, "Rooms");
  // Eight rooms, and the group DM after them (#351).
  await expect(shown).toHaveCount(9);
  await expect(shown.first()).toContainText("general");
  await expect(shown.last()).toContainText("Eli and Sam");
  const more = page.getByRole("button", { name: /More rooms/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).not.toHaveText(/\d/);
  await more.click();
  await expect(rows(page, "More rooms")).toHaveCount(7);
  await expect(rows(page, "More rooms").first()).toContainText("quiet-room");
});

test("groups people into here, away and a folded offline", async ({ page }) => {
  // Jules first: he wrote to you, and it's unread (#351).
  await expect(rows(page, "People here")).toHaveText([/Jules.*in #general/, /Dave.*in #listening-room/, /Eli.*in #general/, /Callie.*around/]);
  await expect(rows(page, "Away")).toHaveText([/Sam.*back after work/]);
  await expect(page.getByRole("list", { name: "Offline" })).toHaveCount(0);
  await page.getByRole("button", { name: /Offline/ }).click();
  await expect(rows(page, "Offline")).toHaveText([/Jen.*last here 1d/]);
});

test("keeps every row of a kind the same height, whatever the name's face", async ({ page }) => {
  await page.getByRole("button", { name: /Offline/ }).click();
  const one = (await boxes(rows(page, "Rooms"))).map((box) => box.height);
  const two = [
    ...(await boxes(rows(page, "People here"))),
    ...(await boxes(rows(page, "Away"))),
    ...(await boxes(rows(page, "Offline"))),
  ].map((box) => box.height);
  expect(new Set(one)).toEqual(new Set([32]));
  expect(new Set(two)).toEqual(new Set([48]));
});

test("starts every name at the same place, whatever leads the row", async ({ page }) => {
  const starts = await page
    .locator(".nx-list-scroll .k-row-title")
    .evaluateAll((titles) => titles.map((title) => Math.round(title.getBoundingClientRect().x)));
  expect(starts.length).toBeGreaterThan(8);
  expect(new Set(starts).size).toBe(1);
});

test("opens a room, a group DM and a person by click and by keyboard (#351)", async ({ page }) => {
  await rows(page, "Rooms").first().getByRole("button").first().click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general");
  await rows(page, "Rooms").filter({ hasText: "Eli and Sam" }).getByRole("button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general,dm:d-eli-sam");
  // A person opens them beside the list: your DM with them, or a new one.
  await rows(page, "People here").filter({ hasText: "Jules" }).getByRole("button").first().click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", /,person:u-jules:d-jules$/);
  await rows(page, "People here").filter({ hasText: "Callie" }).getByRole("button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-opened", /,person:u-callie:new$/);
  // No card opens on the way: a click is the person, not a look at them.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("a person's card", () => {
  test("opens from their row with their status, and focus goes in and comes back", async ({ page }) => {
    const row = rows(page, "Away").first().getByRole("button").first();
    await openCardByKeyboard(page, "Away", "Sam");
    const card = page.getByRole("dialog", { name: "Sam" });
    await expect(card).toContainText("back after work");
    await expect(card.getByRole("button", { name: "Message" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  // A pointer open lights nothing: a ring on a button nobody reached with the
  // keyboard reads as a stray highlight (A11Y-1, #96, #143). A keyboard open
  // shows where focus went.
  test("opened with the mouse, no focus ring shows; opened from the keyboard, it does (A11Y-1)", async ({ page }) => {
    const row = rows(page, "People here").filter({ hasText: "Jules" }).getByRole("button").first();
    const card = page.getByRole("dialog", { name: "Jules" });
    const message = card.getByRole("button", { name: "Message" });
    await openCard(page, "People here", "Jules");
    await expect(message).toBeFocused();
    await expect(message).toHaveCSS("outline-style", "none");
    await expect(page.locator("[data-kit='Tooltip']")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    await row.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(message).toBeFocused();
    await expect(message).toHaveCSS("outline-style", "solid");
  });

  test("a knock still waiting can't be pressed again; one that failed says so, and trying again clears it", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?holdknock");
    await openCard(page, "People here", "Jules");
    const card = page.getByRole("dialog", { name: "Jules" });
    const knock = card.getByRole("button", { name: /^Knock/ });
    const knocks = async () => ((await page.locator("body").getAttribute("data-opened")) ?? "").split(",").filter((line) => line.startsWith("knock:"));
    await knock.click();
    await expect(knock).toBeDisabled();
    await knock.dispatchEvent("click");
    expect(await knocks()).toHaveLength(1);
    await page.evaluate(() => window.answerKnock?.(false));
    await expect(card.getByRole("status")).toHaveText("Couldn't knock.");
    await expect(knock).toBeEnabled();
    await knock.click();
    await expect(card.getByRole("status")).toHaveCount(0);
    await page.evaluate(() => window.answerKnock?.(true));
    await expect(card.getByRole("button", { name: "Knocked" })).toBeVisible();
    expect(await knocks()).toHaveLength(2);
  });

  test("a knock answered after its card closed lands on nobody else's card", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?holdknock");
    await openCard(page, "People here", "Jules");
    await page.getByRole("dialog", { name: "Jules" }).getByRole("button", { name: /^Knock/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Jules" })).toHaveCount(0);
    await openCard(page, "Away", "Sam");
    const sam = page.getByRole("dialog", { name: "Sam" });
    await expect(sam).toBeVisible();
    await page.evaluate(() => window.answerKnock?.(false));
    await page.waitForTimeout(200);
    await expect(sam.getByRole("status")).toHaveCount(0);
    await expect(sam.getByRole("button", { name: "Knock" })).toBeEnabled();
  });

  test("shows what somebody is listening to, reading or working on", async ({ page }) => {
    await openCard(page, "People here", "Jules");
    const card = page.getByRole("dialog", { name: "Jules" });
    await expect(card).toContainText("speakers: finally set up");
    await expect(card).toContainText("Listening to");
    await expect(card).toContainText("Khruangbin — Con Todo El Mundo");
  });

  // Fields with labels people chose (#270): each shown as its label and what
  // it says, in order, and a web address in one drawn as a link that opens
  // in the browser (window.open outside the desktop app, the opener inside
  // it), never in this window. Nothing else in a value is a link.
  test("shows each field's label and what it says, web addresses as links that open in the browser (#270)", async ({ page }) => {
    await page.addInitScript(() => {
      const opened: string[] = [];
      Object.defineProperty(window, "openedLinks", { value: opened });
      window.open = (url?: string | URL) => {
        opened.push(String(url));
        return null;
      };
    });
    await page.goto("/tests/fixtures/next-list.html?fields");
    await openCard(page, "People here", "Jules");
    const card = page.getByRole("dialog", { name: "Jules" });
    await expect(card.locator("dt")).toHaveText(["Listening to", "GitHub", "Playing"]);
    await expect(card.locator("dd")).toHaveText(["Khruangbin — Con Todo El Mundo", "github.com/bendthebracket", "Outer Wilds, not main.rs. https://www.mobiusdigitalgames.com"]);
    const links = card.getByRole("link");
    await expect(links).toHaveText(["github.com/bendthebracket", "https://www.mobiusdigitalgames.com"]);
    await expect(links.first()).toHaveAttribute("title", "https://github.com/bendthebracket");
    const opened = () => page.evaluate(() => Reflect.get(window, "openedLinks"));
    const at = page.url();

    await links.first().click();
    expect(await opened()).toEqual(["https://github.com/bendthebracket"]);
    expect(page.url()).toBe(at);
    // The words around a link, and a name that only looks like an address, open nothing.
    await card.getByText("Outer Wilds, not main.rs.").click({ position: { x: 4, y: 4 } });
    await card.locator("dd").first().click();
    expect(await opened()).toEqual(["https://github.com/bendthebracket"]);
    // From the keyboard too.
    await links.nth(1).focus();
    await page.keyboard.press("Enter");
    expect(await opened()).toEqual(["https://github.com/bendthebracket", "https://www.mobiusdigitalgames.com/"]);
    await expect(card).toBeVisible();
  });

  // At their longest, in the 340-wide list window at 100% and 200%: the card
  // fits the window, a long label wraps in its column, a long address wraps
  // inside the card, and nothing is cut off. Saved for a person to look at.
  for (const scale of [1, 2]) {
    test.describe(`at ${scale * 100}%`, () => {
      test.use({ deviceScaleFactor: scale });
      test("long fields fit the card, with nothing cut off (#270)", async ({ page }) => {
        await page.goto("/tests/fixtures/next-list.html?fields&long");
        await page.evaluate(() => document.fonts.ready);
        for (const [name, opener] of [
          ["Jules", () => openCard(page, "People here", "Jules")],
          ["Matt", () => page.getByRole("region", { name: "You" }).getByRole("button", { name: "Matt" }).click()],
        ] as const) {
          await opener();
          const card = page.getByRole("dialog", { name });
          await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
          await expect(card.locator("dt")).toHaveText(["Supercalifragilisticexpi", "Currently obsessing over", "GitHub"]);
          const box = await card.boundingBox();
          const size = page.viewportSize();
          if (!box || !size) throw new Error("the card isn't drawn");
          expect(box.x).toBeGreaterThanOrEqual(8);
          expect(box.x + box.width).toBeLessThanOrEqual(size.width - 8);
          expect(box.y + box.height).toBeLessThanOrEqual(size.height - 8);
          const laid = await card.evaluate((node) => {
            const edge = node.getBoundingClientRect();
            const parts = [...node.querySelectorAll<HTMLElement>(".nx-person-fields dt, .nx-person-fields dd, .nx-person-link")];
            return {
              clipped: [...node.querySelectorAll<HTMLElement>(".nx-person *")].filter((one) => one.scrollWidth > one.clientWidth + 1 && getComputedStyle(one).textOverflow !== "ellipsis").map((one) => one.className || one.tagName),
              outside: parts.filter((one) => [...one.getClientRects()].some((rect) => rect.left < edge.left - 0.5 || rect.right > edge.right + 0.5)).map((one) => one.textContent),
              // What each field says starts on one edge.
              starts: new Set([...node.querySelectorAll(".nx-person-fields dd")].map((dd) => Math.round(dd.getBoundingClientRect().left))).size,
            };
          });
          expect(laid).toEqual({ clipped: [], outside: [], starts: 1 });
          await page.mouse.move(0, 0);
          await card.screenshot({ path: `test-results/status-fields/card-${name.toLowerCase()}-${test.info().project.name}-${scale * 100}.png`, animations: "disabled" });
          await page.keyboard.press("Escape");
          await expect(card).toHaveCount(0);
        }
      });
    });
  }

  test("Message starts the DM and closes the card", async ({ page }) => {
    await openCard(page, "Away", "Sam");
    await page.getByRole("dialog", { name: "Sam" }).getByRole("button", { name: "Message" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "message:u-sam");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Knock says Knocked for three seconds, then is ready again", async ({ page }) => {
    const opened = new Date("2026-09-25T20:00:00");
    await page.clock.install({ time: opened });
    await page.reload();
    // Standing still, so "Knocked" is still up when it's looked at on a slow machine.
    await page.clock.pauseAt(new Date(opened.getTime() + 600_000));
    await openCard(page, "Away", "Sam");
    const card = page.getByRole("dialog", { name: "Sam" });
    await card.getByRole("button", { name: "Knock" }).click();
    await expect(card.getByRole("button", { name: "Knocked" })).toBeDisabled();
    await page.clock.fastForward(3_100);
    await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "knock:u-sam");
  });

  test("a knock refused for the hour says so in words", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?limit");
    await openCard(page, "Away", "Sam");
    const card = page.getByRole("dialog", { name: "Sam" });
    await card.getByRole("button", { name: "Knock" }).click();
    await expect(card.getByRole("status")).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
    await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
  });

  // Both sentences don't fit on one line in a 340-wide list window (#268:
  // the card leaves about 276px for about 345px of words), so the line breaks
  // between them and each sentence stays whole on a line of its own, at 100%
  // and at 200% interface size. The card is saved for a person to look at.
  for (const scale of [1, 2]) {
    test.describe(`at ${scale * 100}%`, () => {
      test.use({ deviceScaleFactor: scale });
      test("a refused knock's sentences each sit on one line", async ({ page }) => {
        await page.goto("/tests/fixtures/next-list.html?limit");
        await page.evaluate(() => document.fonts.ready);
        await openCard(page, "Away", "Sam");
        const card = page.getByRole("dialog", { name: "Sam" });
        await card.getByRole("button", { name: "Knock" }).click();
        const note = card.getByRole("status");
        await expect(note).toHaveText("Three knocks this hour. You can knock again in 20 minutes.");
        await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
        const laid = await note.evaluate((node) => {
          const edge = node.getBoundingClientRect();
          return [...node.children].map((sentence) => {
            const words = document.createRange();
            words.selectNodeContents(sentence);
            const boxes = [...words.getClientRects()];
            return {
              text: sentence.textContent,
              lines: new Set(boxes.map((box) => Math.round(box.top))).size,
              top: Math.round(words.getBoundingClientRect().top),
              inside: boxes.every((box) => box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5),
            };
          });
        });
        expect(laid.map(({ text, lines, inside }) => ({ text, lines, inside }))).toEqual([
          { text: "Three knocks this hour.", lines: 1, inside: true },
          { text: "You can knock again in 20 minutes.", lines: 1, inside: true },
        ]);
        expect(laid[1]?.top).toBeGreaterThan(laid[0]?.top ?? Infinity);
        await page.mouse.move(0, 0);
        await card.screenshot({ path: `test-results/knock-limit/${test.info().project.name}-${scale * 100}.png`, animations: "disabled" });
      });
    });
  }

  test("nobody offline can be knocked, and the card says why (#288)", async ({ page }) => {
    await page.getByRole("button", { name: /Offline/ }).click();
    await openCard(page, "Offline", "Jen");
    const card = page.getByRole("dialog", { name: "Jen" });
    const knock = card.getByRole("button", { name: "Knock" });
    await expect(knock).toBeDisabled();
    // Where a refused knock's sentence goes, and quietly: offline isn't a failure.
    await expect(card.getByRole("status")).toHaveText("Can't knock while Jen is offline.");
    const tones = await card.evaluate((node) => {
      const note = node.querySelector(".nx-person-problem");
      const probe = document.createElement("p");
      probe.className = "nx-person-problem";
      node.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return { note: note ? getComputedStyle(note).color : "", red };
    });
    expect(tones.note).not.toBe(tones.red);
    await expect(knock).toHaveAccessibleDescription("Can't knock while Jen is offline.");
    // The keyboard reaches it, and pressing it does nothing.
    await card.getByRole("button", { name: "Message" }).focus();
    await page.keyboard.press("Tab");
    await expect(knock).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("body")).not.toHaveAttribute("data-opened", "knock:u-jen");
    // The pointer gets the reason too.
    await knock.hover();
    await expect(page.locator("[data-kit='Tooltip']")).toHaveText("Can't knock while Jen is offline.");
  });

  test("always fits inside the list window, above the row when there is no room below", async ({ page }) => {
    await page.getByRole("button", { name: /Offline/ }).click();
    const row = rows(page, "Offline").first().getByRole("button").first();
    await openCard(page, "Offline", "Jen");
    const card = await page.getByRole("dialog", { name: "Jen" }).boundingBox();
    const opened = await row.boundingBox();
    const size = page.viewportSize();
    expect(card && opened && size).toBeTruthy();
    if (!card || !opened || !size) return;
    expect(card.x).toBeGreaterThanOrEqual(8);
    expect(card.x + card.width).toBeLessThanOrEqual(size.width - 8);
    expect(card.y).toBeGreaterThanOrEqual(8);
    expect(card.y + card.height).toBeLessThanOrEqual(size.height - 8);
    // In the middle, measured at its real size (not while its opening animation still shrinks it).
    expect(Math.abs(card.x - (size.width - card.x - card.width))).toBeLessThanOrEqual(1);
  });
});

// Your own name opens your card, the one friends see (#271): the real
// person card, saying whose view it is, with Edit profile in place of
// Message and Knock.
test.describe("your own card", () => {
  const yourName = (page: Page) => page.getByRole("region", { name: "You" }).getByRole("button", { name: "Matt" });

  test("your name opens your card as friends see it, and focus goes in and comes back", async ({ page }) => {
    const name = yourName(page);
    await expect(name).toHaveAttribute("aria-haspopup", "dialog");
    await name.focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("dialog", { name: "Matt" });
    await expect(card).toBeVisible();
    await expect(name).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".nx-person-yours")).toHaveText("This is how friends see you");
    // What friends see: where you are, your status, your fields.
    await expect(card).toContainText("in #general");
    await expect(card).toContainText("fixing the porch light (the real one)");
    await expect(card).toContainText("Working on");
    await expect(card).toContainText("a design for this app");
    // Edit profile, and nothing that makes no sense on yourself.
    await expect(card.getByRole("button", { name: "Edit profile" })).toBeFocused();
    await expect(card.getByRole("button", { name: "Message" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Knock/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-expanded", "false");
  });

  test("Edit profile opens Settings on Profile and closes the card", async ({ page }) => {
    await yourName(page).click();
    await page.getByRole("dialog", { name: "Matt" }).getByRole("button", { name: "Edit profile" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "settings:profile");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(yourName(page)).toBeFocused();
  });

  test("away, it shows your away message where your status was, as friends see it", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?away");
    await yourName(page).click();
    const card = page.getByRole("dialog", { name: "Matt" });
    await expect(card).toContainText("away");
    await expect(card.locator(".nx-person-status")).toHaveText("walking the dog 🐕");
    await expect(card.locator(".nx-person-status")).toHaveAttribute("data-away", "yes");
    await expect(card).not.toContainText("fixing the porch light");
  });

  test("follows plain names, as everyone's card does", async ({ page }) => {
    const painted = () =>
      page
        .getByRole("dialog", { name: "Matt" })
        .locator("[data-kit='Name']")
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, weight: style.fontWeight };
        });
    const plain = await page.locator("body").evaluate((node) => getComputedStyle(node).color);
    await yourName(page).click();
    // Your own style: bold, in your color.
    expect(await painted()).not.toEqual({ color: plain, weight: "500" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.documentElement.setAttribute("data-normalize", "true"));
    await yourName(page).click();
    expect(await painted()).toEqual({ color: plain, weight: "500" });
  });

  // The 340-wide list window, at 100% and 200%: the card fits inside it,
  // centred, its quiet line on one line level with the close button, and
  // nothing cut off. The card is saved for a person to look at.
  for (const scale of [1, 2]) {
    test.describe(`at ${scale * 100}%`, () => {
      test.use({ deviceScaleFactor: scale });
      test("your card fits the list window, with nothing cut off", async ({ page }) => {
        await yourName(page).click();
        const card = page.getByRole("dialog", { name: "Matt" });
        await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
        const box = await card.boundingBox();
        const size = page.viewportSize();
        expect(box && size).toBeTruthy();
        if (!box || !size) return;
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width - 8);
        expect(Math.abs(box.x - (size.width - box.x - box.width))).toBeLessThanOrEqual(1);
        const laid = await card.evaluate((node) => {
          const line = node.querySelector(".nx-person-yours");
          const close = node.querySelector(".k-popover-close button");
          const name = node.querySelector(".nx-person-head [data-kit='Name']");
          if (!line || !close || !name) return null;
          const words = document.createRange();
          words.selectNodeContents(line);
          const lines = new Set([...words.getClientRects()].map((one) => Math.round(one.top))).size;
          const [at, button, head] = [line.getBoundingClientRect(), close.getBoundingClientRect(), name.getBoundingClientRect()];
          const clipped = [...node.querySelectorAll<HTMLElement>(".nx-person *")].filter((one) => one.scrollWidth > one.clientWidth + 1 && getComputedStyle(one).textOverflow !== "ellipsis");
          return {
            lines,
            // Its middle level with the close button's, and clear of it.
            level: Math.abs(at.top + at.height / 2 - (button.top + button.height / 2)),
            clear: words.getBoundingClientRect().right <= button.left,
            // Your name starts under the close button, not beside it.
            below: head.top >= button.bottom,
            clipped: clipped.map((one) => one.className),
          };
        });
        expect(laid).toEqual({ lines: 1, level: expect.any(Number), clear: true, below: true, clipped: [] });
        expect(laid?.level).toBeLessThanOrEqual(1);
        await page.mouse.move(0, 0);
        await card.screenshot({ path: `test-results/your-card/list-${test.info().project.name}-${scale * 100}.png`, animations: "disabled" });
      });
    });
  }
});

test.describe("a person's row", () => {
  test("shows their card and Knock on hover and focus; nobody offline can be knocked", async ({ page }) => {
    const sam = rows(page, "Away").first();
    await sam.hover();
    await expect(sam.getByRole("button", { name: "Sam's card" })).toBeVisible();
    await expect(sam.getByRole("button", { name: "Knock on Sam's door" })).toBeEnabled();
    await page.getByRole("button", { name: /Offline/ }).click();
    const jen = rows(page, "Offline").first();
    await jen.hover();
    // Greyed out, and it says why, in its tooltip and to a screen reader (#288).
    const knock = jen.getByRole("button", { name: "Can't knock while Jen is offline." });
    await expect(knock).toBeDisabled();
    await knock.hover();
    await expect(page.locator("[data-kit='Tooltip']")).toHaveText("Can't knock while Jen is offline.");
    await knock.click({ force: true });
    await expect(page.locator("body")).not.toHaveAttribute("data-opened", "knock:u-jen");
    // The keyboard reaches it: from the row, past their card.
    await page.mouse.move(0, 0);
    await jen.getByRole("button").first().focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(knock).toBeFocused();
    // The row itself opens them, offline or not.
    await jen.getByRole("button").first().click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "person:u-jen:new");
  });

  test("a knock from the row shakes it once and rests three seconds; from the card too", async ({ page }) => {
    const opened = new Date("2026-09-25T20:00:00");
    await page.clock.install({ time: opened });
    await page.reload();
    await page.clock.pauseAt(new Date(opened.getTime() + 600_000));
    const sam = rows(page, "Away").first();
    await sam.hover();
    await sam.getByRole("button", { name: "Knock on Sam's door" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "knock:u-sam");
    await expect(sam).toHaveAttribute("data-knocked", "yes");
    // One shake, about half a second long.
    const shakes = await sam.locator(".k-row-main").evaluate((node) => node.getAnimations().map((running) => Number(running.effect?.getComputedTiming().duration)));
    expect(shakes).toEqual([520]);
    await expect(sam.getByRole("button", { name: "Knocked on Sam's door" })).toBeDisabled();
    await page.clock.fastForward(3_100);
    await expect(sam).not.toHaveAttribute("data-knocked", "yes");
    await expect(sam.getByRole("button", { name: "Knock on Sam's door" })).toBeEnabled();
    // From the card, the row shakes the same way.
    await openCard(page, "Away", "Sam");
    await page.getByRole("dialog", { name: "Sam" }).getByRole("button", { name: "Knock" }).click();
    await expect(sam).toHaveAttribute("data-knocked", "yes");
  });

  test("a knock from the row that doesn't go opens their card saying why", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?limit");
    const sam = rows(page, "Away").first();
    await sam.hover();
    await sam.getByRole("button", { name: "Knock on Sam's door" }).click();
    const card = page.getByRole("dialog", { name: "Sam" });
    await expect(card).toContainText("Three knocks this hour. You can knock again in 20 minutes.");
    // Read once, not waited for: a shake would be over in three seconds anyway.
    expect(await sam.getAttribute("data-knocked")).toBeNull();
  });

  test("hovering shows their whole status when the row has had to cut it short (#351)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?longstatus");
    await page.evaluate(() => document.fonts.ready);
    const tip = page.locator("[data-kit='Tooltip']");
    const dave = rows(page, "People here").filter({ hasText: "Dave" });
    const detail = dave.locator(".k-row-detail");
    const whole = (await detail.textContent()) ?? "";
    expect(await detail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    await dave.getByRole("button").first().hover();
    await expect(tip).toHaveText(whole);
    await expect(tip).toHaveAttribute("data-placed", "yes");
    await page.mouse.move(1, 1);
    await expect(tip).toHaveCount(0);
    // A status that fits isn't repeated.
    await rows(page, "People here").filter({ hasText: "Eli" }).getByRole("button").first().hover();
    await expect(tip).toHaveCount(0);
  });

  test("the shake doesn't move for somebody who asked for less motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const sam = rows(page, "Away").first();
    await sam.hover();
    await sam.getByRole("button", { name: "Knock on Sam's door" }).click();
    await expect(sam).toHaveAttribute("data-knocked", "yes");
    const lasts = await sam.locator(".k-row-main").evaluate((node) => node.getAnimations().map((running) => running.effect?.getComputedTiming().duration));
    for (const duration of lasts) expect(Number(duration)).toBeLessThanOrEqual(2);
  });
});

test.describe("the picker for a group", () => {
  const picker = (page: Page) => page.getByRole("dialog", { name: "Start a group" });
  const offered = (page: Page) => rows(page, "People to pick");
  const openPicker = async (page: Page) => {
    await page.getByRole("button", { name: "Start a group" }).click();
    await expect(picker(page)).toBeVisible();
  };

  test("opens from the + on Rooms on everyone but you, typing already (#351)", async ({ page }) => {
    await openPicker(page);
    await expect(offered(page)).toHaveText([/Callie/, /Dave/, /Eli/, /Jen/, /Jules/, /Sam/]);
    await expect(picker(page).getByRole("textbox", { name: "Add someone" })).toBeFocused();
    await expect(picker(page).getByRole("status")).toHaveText("Pick up to 7 people.");
    await expect(picker(page).getByRole("button", { name: "Start the DM" })).toBeDisabled();
  });

  test("finds people by name whatever the case, and says when nobody matches", async ({ page }) => {
    await openPicker(page);
    await page.keyboard.type("JUL");
    await expect(offered(page)).toHaveText([/Jules/]);
    await page.keyboard.type("x");
    await expect(picker(page)).toContainText("Nobody called “JULx”.");
  });

  test("Enter picks the first match and Backspace takes the last pick back", async ({ page }) => {
    await openPicker(page);
    await page.keyboard.type("ca");
    await page.keyboard.press("Enter");
    await expect(picker(page).getByRole("button", { name: "Remove Callie" })).toBeVisible();
    await expect(offered(page)).not.toContainText(["Callie"]);
    await page.keyboard.press("Backspace");
    await expect(picker(page).getByRole("button", { name: "Remove Callie" })).toHaveCount(0);
    await expect(offered(page).first()).toContainText("Callie");
  });

  test("a set of people you already have a DM with opens that DM", async ({ page }) => {
    await openPicker(page);
    await offered(page).getByRole("button", { name: "Add Jules" }).click();
    await expect(picker(page).getByRole("status")).toHaveText("You already have a DM with Jules.");
    await expect(picker(page).getByRole("button", { name: "Open the DM" })).toBeEnabled();
    await offered(page).getByRole("button", { name: "Add Eli" }).click();
    await expect(picker(page).getByRole("status")).toHaveText("A new DM with Jules and Eli.");
    await picker(page).getByRole("button", { name: "Remove Jules" }).click();
    await offered(page).getByRole("button", { name: "Add Sam" }).click();
    await expect(picker(page).getByRole("button", { name: "Open the DM" })).toBeVisible();
  });

  test("Start the DM hands over exactly who was picked, then closes", async ({ page }) => {
    await openPicker(page);
    await offered(page).getByRole("button", { name: "Add Eli" }).click();
    await offered(page).getByRole("button", { name: "Add Callie" }).click();
    await picker(page).getByRole("button", { name: "Start the DM" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "newdm:u-eli,u-callie");
    await expect(picker(page)).toHaveCount(0);
  });

  test("a DM the server won't open says so and keeps the picks", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?dmfail");
    await openPicker(page);
    await offered(page).getByRole("button", { name: "Add Eli" }).click();
    await picker(page).getByRole("button", { name: "Start the DM" }).click();
    await expect(picker(page).getByRole("status")).toHaveText("The server didn't answer.");
    await expect(picker(page).getByRole("button", { name: "Remove Eli" })).toBeVisible();
    await expect(picker(page).getByRole("button", { name: "Start the DM" })).toBeEnabled();
  });

  test("stops at seven people, the most a DM holds besides you", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?crowd");
    await openPicker(page);
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press("Enter");
    }
    await expect(picker(page).getByRole("button", { name: /^Remove / })).toHaveCount(7);
    await expect(picker(page).getByRole("textbox")).toBeDisabled();
    await expect(offered(page).getByRole("button").first()).toBeDisabled();
  });

  test("Escape closes it and focus goes back to the button", async ({ page }) => {
    await openPicker(page);
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start a group" })).toBeFocused();
  });

  test("fits inside the list window, in the middle, and stays put as people are picked", async ({ page }) => {
    await openPicker(page);
    // Once the opening animation is over, the box is its real size.
    await picker(page).evaluate((dialog) => Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const box = await picker(page).boundingBox();
    const size = page.viewportSize();
    expect(box && size).toBeTruthy();
    if (!box || !size) return;
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height - 8);
    expect(Math.abs(box.x - (size.width - box.x - box.width))).toBeLessThanOrEqual(1);
    await offered(page).getByRole("button", { name: "Add Eli" }).click();
    expect((await picker(page).boundingBox())?.x).toBe(box.x);
  });
});

test("says in words what the markers show", async ({ page }) => {
  await expect(page.getByRole("button", { name: "#general, 3 people in it, voice on" })).toBeVisible();
  await expect(page.getByRole("button", { name: "#listening-room, one person in it" })).toBeVisible();
});

test.describe("who's muted, and who can't be reached", () => {
  test("each person's shared microphone shows as its control's glyph, with the word for a screen reader", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&ptt&mics");
    const who = page.getByRole("list", { name: "Who's in voice" });
    const jules = who.getByRole("listitem").filter({ hasText: "Jules" });
    await expect(jules.locator(".k-chip-state")).toHaveText("Deafened");
    await expect(jules).toContainText("can't reach");
    // An older client or server doesn't share it: said, not guessed.
    const eli = who.getByRole("listitem").filter({ hasText: "Eli" });
    await expect(eli).toContainText("mic state unknown");
    await expect(eli.locator(".k-chip-state")).toHaveCount(0);
    // Yours, from your own controls: push-to-talk with the key up closes the
    // microphone but isn't a mute, so nothing shows (#232).
    await expect(who.getByRole("listitem").filter({ hasText: "you" }).locator(".k-chip-state")).toHaveCount(0);
  });

  test("a mute you chose shows on your chip, with push-to-talk or without (#232)", async ({ page }) => {
    for (const query of ["voice&muted", "voice&ptt&muted"]) {
      await page.goto(`/tests/fixtures/next-list.html?${query}`);
      const who = page.getByRole("list", { name: "Who's in voice" });
      await expect(who.getByRole("listitem").filter({ hasText: "you" }).locator(".k-chip-state")).toHaveText("Muted");
      await expect(page.getByRole("region", { name: "In voice in #general" }).getByRole("button", { name: "Muted" })).toHaveAttribute("aria-pressed", "true");
    }
  });

  test("nothing shows while everyone's on and reachable", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const who = page.getByRole("list", { name: "Who's in voice" });
    await expect(who.locator(".k-chip-state, .k-chip-note")).toHaveCount(0);
  });
});

test.describe("in voice", () => {
  // The voice bar sits on the list's bottom edge, where a tooltip drawn
  // below its buttons would be cut off by the window.
  for (const [width, height] of [[340, 820], [300, 480]] as const) {
    test(`the voice bar's tooltips show whole at ${width} by ${height} (#140)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/tests/fixtures/next-list.html?voice");
      const yours = page.getByRole("region", { name: "In voice in #general" }).getByRole("group", { name: "Your voice" });
      for (const name of ["Mute", "Deafen", "Leave voice"]) {
        await expectWholeTooltip(page, yours.getByRole("button", { name, exact: true }), name);
      }
    });
  }

  test("the voice bar names the room, lights who is talking, and offers the three controls", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await expect(bar).toContainText("In voice");
    await expect(bar.getByRole("list", { name: "Who's in voice" }).locator("li")).toHaveText(["you", "Eli", "Jules"]);
    const lit = await bar.locator("[data-kit='Chip']").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-active")));
    expect(lit).toEqual([null, "yes", null]);
    for (const name of ["Mute", "Deafen", "Leave"]) await expect(bar.getByRole("button", { name })).toBeVisible();
    const heights = await bar.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([24]));
  });

  test("Mute, Deafen and Leave are symbols with no words showing, named for the tooltip and screen readers, as in the chat window (#230)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    const yours = bar.getByRole("group", { name: "Your voice" });
    await expect(yours.getByRole("button")).toHaveCount(3);
    await expect(yours).toHaveText("");
    for (const name of ["Mute", "Deafen", "Leave voice"]) {
      const button = yours.getByRole("button", { name, exact: true });
      await expect(button).toHaveAttribute("data-kit", "IconButton");
      await expect(button).toHaveText("");
      if (name === "Leave voice") await expect(button).not.toHaveAttribute("aria-pressed");
      else await expect(button).toHaveAttribute("aria-pressed", "false");
      const box = await button.boundingBox();
      expect(box && [box.width, box.height]).toEqual([24, 24]);
      // The word shows on hover.
      await button.hover();
      await expect(page.locator("[data-kit='Tooltip']")).toHaveText(name);
    }
    const restingMic = await yours.getByRole("button", { name: "Mute", exact: true }).locator("svg").innerHTML();
    const restingHead = await yours.getByRole("button", { name: "Deafen", exact: true }).locator("svg").innerHTML();

    // Pressed: named for what's on, and crossed out like the glyph beside your name.
    const you = bar.getByRole("list", { name: "Who's in voice" }).getByRole("listitem").filter({ hasText: "you" });
    await page.goto("/tests/fixtures/next-list.html?voice&muted");
    const muted = yours.getByRole("button", { name: "Muted", exact: true });
    await expect(muted).toHaveAttribute("aria-pressed", "true");
    await expect(muted).toHaveText("");
    const mutedMic = await muted.locator("svg").innerHTML();
    expect(mutedMic).not.toBe(restingMic);
    expect(mutedMic).toBe(await you.locator(".k-chip-state svg").innerHTML());

    await page.goto("/tests/fixtures/next-list.html?voice&deafened");
    const deafened = yours.getByRole("button", { name: "Deafened", exact: true });
    await expect(deafened).toHaveAttribute("aria-pressed", "true");
    await expect(deafened).toHaveText("");
    const deafenedHead = await deafened.locator("svg").innerHTML();
    expect(deafenedHead).not.toBe(restingHead);
    expect(deafenedHead).toBe(await you.locator(".k-chip-state svg").innerHTML());
    await expect(yours).toHaveText("");
  });

  test("its controls do what they say", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await bar.getByRole("button", { name: "Mute" }).click();
    await bar.getByRole("button", { name: "Deafen" }).click();
    await bar.getByRole("button", { name: "Leave" }).click();
    await bar.getByRole("button", { name: "Go to #general" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "mute:true,deafen:true,leave,go:r-general");
  });

  test("with push-to-talk it names the key to hold, shows no mute, and keeps Mute for a mute you choose (#232)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&ptt");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    // Mute, Deafen and Leave are symbols (#230); the line is an instruction, so it stays in words.
    await expect(bar.getByRole("group", { name: "Your voice" }).getByRole("button")).toHaveText(["", "", ""]);
    await expect(bar.getByRole("status")).toHaveText("hold Right Ctrl to talk");
    await expect(bar.locator(".k-chip-state")).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute("aria-pressed", "false");
    // Muted, holding the key would do nothing, so the bar doesn't offer it.
    await page.goto("/tests/fixtures/next-list.html?voice&ptt&muted");
    await expect(page.getByRole("region", { name: "In voice in #general" }).getByRole("status")).toHaveCount(0);
  });

  test("says when the microphone picked in Settings wouldn't open, wrapped inside the bar (#398)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&ptt&refused");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    const line = bar.getByRole("status");
    // Ahead of the push-to-talk reminder: on the default, the key opens a microphone you didn't pick.
    await expect(line).toHaveText("Headset Microphone (SteelSeries Arctis Nova 5) wouldn't open, so you're on the system default (the device is in use)");
    const [lineBox, barBox] = [await line.boundingBox(), await bar.boundingBox()];
    expect(lineBox && barBox && lineBox.x >= barBox.x && lineBox.x + lineBox.width <= barBox.x + barBox.width + 0.5).toBe(true);
  });

  test("the host takes somebody out of voice from their chip's card; nobody else is offered it (#423)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&takeout");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await bar.getByRole("button", { name: /^Eli's volume/ }).click();
    const card = page.getByRole("dialog", { name: "Eli's volume" });
    await card.getByRole("button", { name: "Take out of voice" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "takeout:r-general:u-eli");
    await expect(card).toHaveCount(0);

    // Refused: the card stays, and says why.
    await page.goto("/tests/fixtures/next-list.html?voice&takeout&takeoutfail");
    await page.getByRole("region", { name: "In voice in #general" }).getByRole("button", { name: /^Eli's volume/ }).click();
    const refused = page.getByRole("dialog", { name: "Eli's volume" });
    await refused.getByRole("button", { name: "Take out of voice" }).click();
    await expect(refused.getByRole("alert")).toHaveText("They aren't in voice there.");
  });

  test("the list scrolls above the bar and nothing is hidden under it", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const scroll = await page.locator(".nx-list-scroll").boundingBox();
    const bar = await page.getByRole("region", { name: "In voice in #general" }).boundingBox();
    expect(scroll && bar && scroll.y + scroll.height <= bar.y + 0.5).toBe(true);
  });
});

test.describe("you, at the top", () => {
  test("change your status line: Enter saves, Escape leaves it alone", async ({ page }) => {
    const you = page.getByRole("region", { name: "You" });
    const line = you.getByRole("button", { name: /Your status: fixing the porch light/ });
    await line.click();
    const field = you.getByRole("textbox", { name: "Your status" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("fixing the porch light (the real one)");
    await field.fill("second coffee");
    await page.keyboard.press("Enter");
    await expect(page.locator("body")).toHaveAttribute("data-opened", "line:second coffee");
    await expect(field).toHaveCount(0);

    await line.click();
    await field.fill("never mind");
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(line).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "line:second coffee");
  });

  test("a status line that's too long says so and isn't saved", async ({ page }) => {
    const you = page.getByRole("region", { name: "You" });
    await you.getByRole("button", { name: /Your status/ }).click();
    await you.getByRole("textbox", { name: "Your status" }).fill("a".repeat(250));
    await page.keyboard.press("Enter");
    await expect(you).toContainText("That's 10 characters too long.");
    await expect(page.locator("body")).not.toHaveAttribute("data-opened", /line:/);
  });

  test("go away with a preset, seeing what friends will see", async ({ page }) => {
    await page.getByRole("region", { name: "You" }).getByRole("button", { name: "Away" }).click();
    const editor = page.getByRole("dialog", { name: "Away message" });
    await editor.getByRole("button", { name: "asleep 💤" }).click();
    await expect(editor).toContainText("Friends see");
    await expect(editor).toContainText("“asleep 💤”");
    await editor.getByRole("button", { name: "I'm away" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "away:asleep 💤");
    await expect(editor).toHaveCount(0);
  });

  test("when you're away it shows your message and offers I'm back", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?away");
    const you = page.getByRole("region", { name: "You" });
    await expect(you).toContainText("“walking the dog 🐕”");
    await you.getByRole("button", { name: "I'm back" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "back");
  });

  // Still away is easy to miss (#392): the card takes on the away warm, with
  // the away message boxed where your status was and I'm back filled. None of
  // it is the lamp, which a DM you haven't read is lit in.
  test("when you're away the card looks it, in the away warm and never the lamp (#392)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?away");
    const you = page.getByRole("region", { name: "You" });
    await expect(you).toHaveAttribute("data-away", "yes");
    const back = you.getByRole("button", { name: "I'm back" });
    await expect(back).toHaveAttribute("data-variant", "away");
    const looks = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.append(probe);
      const of = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const card = document.querySelector<HTMLElement>(".nx-you");
      const button = document.querySelector<HTMLElement>(".nx-you .k-button");
      const message = document.querySelector<HTMLElement>(".nx-you-away");
      const lit = document.querySelector<HTMLElement>("[data-lit='yes']");
      const out = {
        card: card ? getComputedStyle(card).backgroundColor : "",
        button: button ? getComputedStyle(button).backgroundColor : "",
        edge: message ? getComputedStyle(message).borderTopColor : "",
        lit: lit ? getComputedStyle(lit).backgroundColor : "",
        wash: of("--away-wash"),
        fill: of("--away-fill"),
        awayEdge: of("--away-edge"),
        lamp: of("--accent"),
      };
      probe.remove();
      return out;
    });
    expect(looks.card).toBe(looks.wash);
    expect(looks.button).toBe(looks.fill);
    expect(looks.edge).toBe(looks.awayEdge);
    expect([looks.card, looks.button, looks.edge]).not.toContain(looks.lit);
    expect([looks.card, looks.button, looks.edge]).not.toContain(looks.lamp);
  });

  test("back at the computer and still away, the card says so beside I'm back, and can be waved off (#392)", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?away&back");
    const you = page.getByRole("region", { name: "You" });
    await expect(you.getByRole("status")).toHaveText("Welcome back. You're still away.");
    await you.getByRole("button", { name: "Stay away for now" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "stay away");
    // Not away, nothing to say.
    await page.goto("/tests/fixtures/next-list.html?back");
    await expect(page.getByRole("region", { name: "You" }).getByRole("status")).toHaveCount(0);
  });

  test("the away editor fits inside the list window", async ({ page }) => {
    await page.getByRole("region", { name: "You" }).getByRole("button", { name: "Away" }).click();
    const box = await page.getByRole("dialog", { name: "Away message" }).boundingBox();
    const size = page.viewportSize();
    expect(box && size && box.x >= 8 && box.x + box.width <= size.width - 8 && box.y + box.height <= size.height - 8).toBe(true);
  });
});

// Raid night (#197): 48 people in #general's voice, on a server big enough
// that People folds everyone you don't talk to (fixtures/next/raid.ts).
test.describe("raid night", () => {
  async function raid(page: Page, extra = "") {
    await page.goto(`/tests/fixtures/next-list.html?voice&raid${extra}`);
    await expect(page.locator("body")).toHaveAttribute("data-raid", "ready");
    await page.evaluate(() => document.fonts.ready);
  }
  const talk = (page: Page, ids: string[]) => page.evaluate((who) => window.talk?.(who), ids);
  const seats = (page: Page) => page.getByRole("list", { name: "You and who just talked" }).getByRole("listitem");

  test("a small room's voice bar is as it always was: everybody as a chip, and no crowd", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await expect(bar.getByRole("list", { name: "Who's in voice" }).getByRole("listitem")).toHaveText(["you", "Eli", "Jules"]);
    await expect(bar.getByRole("button", { name: "Everyone in voice" })).toHaveCount(0);
  });

  test("a big room's voice bar seats you and whoever just talked, and nobody moves while they talk", async ({ page }) => {
    await raid(page);
    // Eli was talking as the bar opened; the other seats are the first to join.
    await expect(seats(page)).toHaveText(["you", "Eli", "Jules", "Kestrel", "Bramble", "Oxbow"]);
    // Fennick talks: he takes the seat of whoever spoke longest ago (Jules never did).
    await talk(page, ["u-raid-12"]);
    await expect(seats(page)).toHaveText(["you", "Eli", "Fennick", "Kestrel", "Bramble", "Oxbow"]);
    await expect(seats(page).filter({ hasText: "Fennick" }).locator("[data-kit='Chip']")).toHaveAttribute("data-active", "yes");
    // He stops: nothing moves, and nothing is lit.
    await talk(page, []);
    await expect(seats(page)).toHaveText(["you", "Eli", "Fennick", "Kestrel", "Bramble", "Oxbow"]);
    await expect(seats(page).locator("[data-active='yes']")).toHaveCount(0);
    // Yarrow talks: the oldest seat is Kestrel's, who never spoke; Eli and Fennick keep theirs.
    await talk(page, ["u-raid-30"]);
    await expect(seats(page)).toHaveText(["you", "Eli", "Fennick", "Yarrow", "Bramble", "Oxbow"]);
    // Seats are two lines of three, every one 24px tall and as wide as its column.
    const boxes = await seats(page)
      .locator("[data-kit='Chip']")
      .evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect()).map((box) => ({ top: Math.round(box.top), width: Math.round(box.width), height: box.height })));
    expect(new Set(boxes.map((box) => box.top)).size).toBe(2);
    expect(new Set(boxes.map((box) => box.width)).size).toBe(1);
    expect(new Set(boxes.map((box) => box.height))).toEqual(new Set([24]));
  });

  test("everybody in a big room is a marker in the crowd, lit while they talk, with no number anywhere", async ({ page }) => {
    await raid(page);
    const bar = page.getByRole("region", { name: "In voice in #general" });
    const crowd = bar.getByRole("button", { name: "Everyone in voice" });
    await expect(crowd.locator("[data-kit='Marker']")).toHaveCount(48);
    await talk(page, ["u-raid-0", "u-raid-12", "u-raid-30"]);
    await expect(crowd.locator("[data-lit='yes']")).toHaveCount(3);
    expect(await bar.textContent()).not.toMatch(/\d/);
  });

  test("the crowd opens everyone but you by name, in order; a search finds somebody and Enter opens their volume", async ({ page }) => {
    await raid(page);
    const crowd = page.getByRole("button", { name: "Everyone in voice" });
    await crowd.click();
    await expect(crowd).toHaveAttribute("aria-expanded", "true");
    const card = page.getByRole("dialog", { name: "Everyone in voice in #general" });
    const people = card.getByRole("list", { name: "In voice in #general" }).getByRole("listitem");
    await expect(people).toHaveCount(47);
    await expect(people.first()).toHaveText("Bramble");
    // The search box has the keyboard already.
    await page.keyboard.type("KAI");
    await expect(people).toHaveText(["Kaito"]);
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Kaito's volume" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Kaito's volume" })).toHaveCount(0);
    await expect(crowd).toBeFocused();
  });

  test("a volume card opened from a seat stays put when that seat goes to somebody new", async ({ page }) => {
    await raid(page);
    await seats(page).filter({ hasText: "Bramble" }).getByRole("button").click();
    const card = page.getByRole("dialog", { name: "Bramble's volume" });
    // It scales in as it opens: measured once it has finished.
    await still(card);
    const before = await card.boundingBox();
    // Three new talkers take the three seats nobody has spoken from: Jules's, Kestrel's, Bramble's.
    await talk(page, ["u-raid-12", "u-raid-14", "u-raid-15"]);
    await expect(seats(page).filter({ hasText: "Bramble" })).toHaveCount(0);
    await expect(card).toBeVisible();
    expect(await card.boundingBox()).toEqual(before);
  });

  test("a search that finds nobody says so; Escape closes it and gives the crowd back the keyboard", async ({ page }) => {
    await raid(page);
    const crowd = page.getByRole("button", { name: "Everyone in voice" });
    await crowd.click();
    await page.keyboard.type("zzz");
    await expect(page.getByRole("dialog", { name: "Everyone in voice in #general" })).toContainText("Nobody by that name in voice.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Everyone in voice in #general" })).toHaveCount(0);
    await expect(crowd).toBeFocused();
  });

  test("somebody muted shows it in the card, and somebody talking shows the bars", async ({ page }) => {
    await raid(page);
    await talk(page, ["u-raid-0"]);
    await page.getByRole("button", { name: "Everyone in voice" }).click();
    const people = page.getByRole("dialog", { name: "Everyone in voice in #general" }).getByRole("listitem");
    await expect(people.filter({ hasText: "Grimwald" })).toContainText("Muted");
    await expect(people.filter({ hasText: "Kestrel" }).locator("[data-kit='VoiceGlyph'][data-speaking='yes']")).toHaveCount(1);
  });

  test("a busy room's row shows up to sixteen markers, and a small one shows its own", async ({ page }) => {
    const markers = (page: Page) => page.getByRole("button", { name: /^#general,/ }).locator("[data-kit='Marker']");
    await page.goto("/tests/fixtures/next-list.html");
    await expect(markers(page)).toHaveCount(3);
    await raid(page);
    await expect(markers(page)).toHaveCount(16);
  });

  test("on a big server, People shows the people you talk to and folds everyone else, with no number (option B)", async ({ page }) => {
    await raid(page);
    await expect(rows(page, "People you talk to")).toHaveCount(1);
    await expect(rows(page, "People you talk to").first()).toContainText("Jules");
    const fold = page.getByRole("button", { name: /^Everyone else/ });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toContainText("show");
    await expect(page.getByRole("list", { name: "Everyone else" })).toHaveCount(0);
    // Away has no group of its own here: Sam is with everyone else.
    await expect(page.locator("[data-kit='SectionLabel']").filter({ hasText: /^Away/ })).toHaveCount(0);
    await fold.click();
    await expect(rows(page, "Everyone else").filter({ hasText: "Kestrel" })).toHaveCount(1);
    await expect(rows(page, "Everyone else").filter({ hasText: "Sam" })).toHaveCount(1);
    const headings = await page.locator("[data-kit='SectionLabel']").allTextContents();
    expect(headings.join(" ")).not.toMatch(/\d/);
  });
});

test.describe("one line per person (#197)", () => {
  test("every person's row is one line, 32px, and their status shows on hover", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?oneline");
    await page.evaluate(() => document.fonts.ready);
    const people = rows(page, "People here");
    const heights = await people.locator(".k-row-main").evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([32]));
    await expect(people.locator(".k-row-detail")).toHaveCount(0);
    const dave = people.filter({ hasText: "Dave" });
    await expect(dave.getByRole("button").first()).toHaveAccessibleName(/side two\. nobody talk to me/);
    await dave.hover();
    await expect(page.locator("[data-kit='Tooltip']")).toHaveText("side two. nobody talk to me");
  });

  test("turned on in Settings, a list already open goes to one line at once", async ({ page, context }) => {
    await page.goto("/tests/fixtures/next-list.html");
    const height = () =>
      rows(page, "People here")
        .first()
        .locator(".k-row-main")
        .evaluate((row) => row.getBoundingClientRect().height);
    expect(await height()).toBe(48);
    const settings = await context.newPage();
    await settings.goto("/tests/fixtures/next-settings-window.html?section=appearance");
    await settings.getByRole("switch", { name: "One line per person" }).click();
    await expect.poll(height).toBe(32);
    await settings.getByRole("switch", { name: "One line per person" }).click();
    await expect.poll(height).toBe(48);
  });

  test("two lines are back without it", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html");
    const heights = await rows(page, "People here")
      .locator(".k-row-main")
      .evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([48]));
  });
});

// An app, not a page (#483): the list isn't words to select; what somebody
// wrote on their card is.
test.describe("what can be selected", () => {
  const selected = (page: Page) => page.evaluate(() => String(getSelection()));

  test("select-all and a drag down the list select nothing", async ({ page }) => {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("ControlOrMeta+a");
    expect((await selected(page)).trim()).toBe("");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    const people = (await page.getByRole("list", { name: "People here" }).boundingBox())!;
    await page.mouse.move(people.x + 2, people.y - 12);
    await page.mouse.down();
    await page.mouse.move(people.x + people.width - 8, people.y + people.height - 4, { steps: 8 });
    await page.mouse.up();
    expect((await selected(page)).trim()).toBe("");
  });

  test("what somebody wrote on their card can be selected: their status and their fields", async ({ page }) => {
    await openCard(page, "Away", "Sam");
    await page.getByRole("dialog", { name: "Sam" }).getByText("back after work").click({ clickCount: 3 });
    expect(await selected(page)).toContain("back after work");
    await page.goto("/tests/fixtures/next-list.html?fields");
    await openCard(page, "People here", "Jules");
    await page.getByRole("dialog", { name: "Jules" }).locator("dd").first().click({ clickCount: 3 });
    expect(await selected(page)).toContain("Khruangbin");
  });
});
