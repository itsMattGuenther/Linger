import { expect, type Locator, type Page, test } from "@playwright/test";

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

test("shows the server, you, and the rooms in their order", async ({ page }) => {
  await expect(page.locator(".k-titlebar")).toContainText("The Good Company");
  const you = page.getByRole("region", { name: "You" });
  await expect(you).toContainText("Matt");
  await expect(you).toContainText("in #general");
  await expect(you).toContainText("fixing the porch light (the real one)");
  await expect(rows(page, "Rooms")).toHaveText([/general/, /listening-room/, /weekend-plans/]);
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

test("lists DMs by who is in them, with the new one first", async ({ page }) => {
  await expect(rows(page, "DMs")).toHaveText([/Jules/, /Eli and Sam/]);
});

// The order used to be the order at connect for the whole session: the
// store's newest message wasn't part of it (#248).
test("a new message moves its DM to the top, theirs or yours, and reading it doesn't move it back", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?live");
  await expect(page.locator("body")).toHaveAttribute("data-live", "ready");
  type Live = { said: (roomId: string, authorId: string) => void; read: (roomId: string) => void };
  const live = (act: (linger: Live) => void) => page.evaluate(`(${act.toString()})(window.linger)`);
  // The Jules DM holds something new; the Eli and Sam one was spoken in later.
  await expect(rows(page, "DMs")).toHaveText([/Jules/, /Eli and Sam/]);
  await live((linger) => linger.read("d-jules"));
  await expect(rows(page, "DMs")).toHaveText([/Eli and Sam/, /Jules/]);

  await live((linger) => linger.said("d-jules", "u-jules"));
  await expect(rows(page, "DMs")).toHaveText([/Jules/, /Eli and Sam/]);
  await live((linger) => linger.read("d-jules"));
  await expect(rows(page, "DMs")).toHaveText([/Jules/, /Eli and Sam/]);

  await live((linger) => {
    linger.said("d-eli-sam", "u-matt");
    linger.read("d-eli-sam");
  });
  await expect(rows(page, "DMs")).toHaveText([/Eli and Sam/, /Jules/]);
});

test("somebody idle shows 💤 in their color, and says idle in words (#259)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?idle");
  const callie = rows(page, "People").filter({ hasText: "Callie" });
  const marker = callie.locator('[data-kit="Marker"]');
  await expect(marker).toHaveAttribute("data-state", "idle");
  await expect(marker.locator("svg path")).toHaveCount(3);
  await expect(callie).toContainText("idle");
  // Her row has a second line, and the big Z sits level with her name, not
  // down between the two lines where the dots are centered.
  const level = await callie.evaluate((row) => {
    const title = row.querySelector(".k-row-title");
    const bigZ = row.querySelector('[data-kit="Marker"] svg path')?.getBoundingClientRect();
    if (!title || !bigZ) return null;
    const range = document.createRange();
    range.selectNodeContents(title);
    const name = range.getBoundingClientRect();
    return Math.abs(bigZ.top + bigZ.height / 2 - (name.top + name.height / 2));
  });
  expect(level).not.toBeNull();
  expect(level ?? Infinity).toBeLessThanOrEqual(1);
});

test("with no DMs yet, the heading and its New message button are still there", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?nodms");
  await expect(page.locator("#nx-dms")).toHaveText("No DMs yet.");
  await expect(page.getByRole("button", { name: "New message" })).toBeVisible();
});

test("a brand-new server says so in each empty place, and the host gets a way to fill it (decision 17)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?bare");
  await expect(page.locator("#nx-rooms .nx-list-empty")).toHaveText("No rooms yet.");
  await expect(page.locator("#nx-dms .nx-list-empty")).toHaveText("No DMs yet.");
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
  await expect(shown).toHaveCount(8);
  await expect(shown.first()).toContainText("general");
  const more = page.getByRole("button", { name: /More rooms/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).not.toHaveText(/\d/);
  await more.click();
  await expect(rows(page, "More rooms")).toHaveCount(7);
  await expect(rows(page, "More rooms").first()).toContainText("quiet-room");
});

test("groups people into here, away and a folded offline", async ({ page }) => {
  await expect(rows(page, "People here")).toHaveText([/Dave.*in #listening-room/, /Eli.*in #general/, /Jules.*in #general/, /Callie.*around/]);
  await expect(rows(page, "Away")).toHaveText([/Sam.*back after work/]);
  await expect(page.getByRole("list", { name: "Offline" })).toHaveCount(0);
  await page.getByRole("button", { name: /Offline/ }).click();
  await expect(rows(page, "Offline")).toHaveText([/Jen.*last here 1d/]);
});

test("keeps every row of a kind the same height, whatever the name's face", async ({ page }) => {
  await page.getByRole("button", { name: /Offline/ }).click();
  const one = [...(await boxes(rows(page, "Rooms"))), ...(await boxes(rows(page, "DMs")))].map((box) => box.height);
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

test("opens a room or a DM by click and by keyboard", async ({ page }) => {
  await rows(page, "Rooms").first().getByRole("button").first().click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general");
  await rows(page, "DMs").first().getByRole("button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-opened", "room:r-general,dm:d-jules");
});

test.describe("a person's card", () => {
  test("opens from their row with their status, and focus goes in and comes back", async ({ page }) => {
    const row = rows(page, "Away").first().getByRole("button").first();
    await row.focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("dialog", { name: "Sam" });
    await expect(card).toContainText("back after work");
    await expect(card.getByRole("button", { name: "Message" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("shows what somebody is listening to, reading or working on", async ({ page }) => {
    await rows(page, "People here").filter({ hasText: "Jules" }).getByRole("button").first().click();
    const card = page.getByRole("dialog", { name: "Jules" });
    await expect(card).toContainText("speakers: finally set up");
    await expect(card).toContainText("Listening to");
    await expect(card).toContainText("Khruangbin — Con Todo El Mundo");
  });

  test("Message starts the DM and closes the card", async ({ page }) => {
    await rows(page, "Away").first().getByRole("button").first().click();
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
    await rows(page, "Away").first().getByRole("button").first().click();
    const card = page.getByRole("dialog", { name: "Sam" });
    await card.getByRole("button", { name: "Knock" }).click();
    await expect(card.getByRole("button", { name: "Knocked" })).toBeDisabled();
    await page.clock.fastForward(3_100);
    await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "knock:u-sam");
  });

  test("a knock refused for the hour says so in words", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?limit");
    await rows(page, "Away").first().getByRole("button").first().click();
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
        await rows(page, "Away").first().getByRole("button").first().click();
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

  test("nobody offline can be knocked", async ({ page }) => {
    await page.getByRole("button", { name: /Offline/ }).click();
    await rows(page, "Offline").first().getByRole("button").first().click();
    await expect(page.getByRole("dialog", { name: "Jen" }).getByRole("button", { name: "Knock" })).toBeDisabled();
  });

  test("always fits inside the list window, above the row when there is no room below", async ({ page }) => {
    await page.getByRole("button", { name: /Offline/ }).click();
    const row = rows(page, "Offline").first().getByRole("button").first();
    await row.click();
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

test.describe("a person's row", () => {
  test("shows Message and Knock on hover and focus; nobody offline can be knocked", async ({ page }) => {
    const sam = rows(page, "Away").first();
    await sam.hover();
    await expect(sam.getByRole("button", { name: "Message Sam" })).toBeVisible();
    await expect(sam.getByRole("button", { name: "Knock on Sam's door" })).toBeEnabled();
    await page.getByRole("button", { name: /Offline/ }).click();
    const jen = rows(page, "Offline").first();
    await jen.hover();
    await expect(jen.getByRole("button", { name: "Knock on Jen's door" })).toBeDisabled();
    await jen.getByRole("button", { name: "Message Jen" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "message:u-jen");
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
    await sam.getByRole("button").first().click();
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

  test("a double-click goes straight to the DM, the old AIM habit", async ({ page }) => {
    await rows(page, "People here").filter({ hasText: "Jules" }).getByRole("button").first().dblclick();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "message:u-jules");
    await expect(page.getByRole("dialog")).toHaveCount(0);
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

test.describe("the new-message picker", () => {
  const picker = (page: Page) => page.getByRole("dialog", { name: "New message" });
  const offered = (page: Page) => rows(page, "People to pick");
  const openPicker = async (page: Page) => {
    await page.getByRole("button", { name: "New message" }).click();
    await expect(picker(page)).toBeVisible();
  };

  test("opens from the DMs heading on everyone but you, typing already", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: "New message" })).toBeFocused();
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

  test("the away editor fits inside the list window", async ({ page }) => {
    await page.getByRole("region", { name: "You" }).getByRole("button", { name: "Away" }).click();
    const box = await page.getByRole("dialog", { name: "Away message" }).boundingBox();
    const size = page.viewportSize();
    expect(box && size && box.x >= 8 && box.x + box.width <= size.width - 8 && box.y + box.height <= size.height - 8).toBe(true);
  });
});
