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

test("with no DMs yet, the heading and its New message button are still there", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list.html?nodms");
  await expect(page.locator("#nx-dms")).toHaveText("No DMs yet.");
  await expect(page.getByRole("button", { name: "New message" })).toBeVisible();
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
    await expect(card.getByRole("status")).toHaveText("That's three this hour. Give them a bit.");
    await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
  });

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
    await expect(card).toContainText("That's three this hour. Give them a bit.");
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

  test("its controls do what they say", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await bar.getByRole("button", { name: "Mute" }).click();
    await bar.getByRole("button", { name: "Deafen" }).click();
    await bar.getByRole("button", { name: "Leave" }).click();
    await bar.getByRole("button", { name: "Go to #general" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened", "mute:true,deafen:true,leave,go:r-general");
  });

  test("with push-to-talk there is no Mute button, and it says how to talk", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list.html?voice&ptt");
    const bar = page.getByRole("region", { name: "In voice in #general" });
    await expect(bar.getByRole("button", { name: /^Mute/ })).toHaveCount(0);
    await expect(bar.getByRole("status")).toHaveText("hold control to talk");
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
