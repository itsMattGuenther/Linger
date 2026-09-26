import { expect, type Locator, type Page, test } from "@playwright/test";

// The chat window on the prototype's Friday evening
// (tests/fixtures/next-chat.tsx). What it shows, that it is built the way
// docs/design/system.md says, that it never moves someone who is reading,
// and that it can be used without a mouse.

test.use({ viewport: { width: 780, height: 790 } });

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-chat.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await landed(page);
}

/** The log has settled where it lands: it says it's busy until then. */
async function landed(page: Page) {
  await expect(log(page)).toBeVisible();
  await expect(log(page)).not.toHaveAttribute("aria-busy", "true");
}

function log(page: Page): Locator {
  return page.getByRole("log");
}

function box(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Message/ });
}

/** The row holding a message, found by its words. */
function message(page: Page, words: string | RegExp): Locator {
  return page.locator(".nx-msg", { hasText: words });
}

async function rect(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

async function did(page: Page): Promise<string[]> {
  return ((await page.locator("body").getAttribute("data-did")) ?? "").split("|").filter(Boolean);
}

/** Where a message's row sits inside the log, so a test can tell whether it moved. */
async function offsetIn(page: Page, id: string): Promise<number> {
  return page.evaluate((messageId) => {
    const scroller = document.querySelector(".nx-conv-scroll");
    const row = document.querySelector(`[data-message="${messageId}"]`);
    if (!scroller || !row) return Number.NaN;
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, id);
}

/** The first message whose row is fully inside the log's view. */
async function firstInView(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".nx-conv-scroll");
    if (!scroller) return "";
    const view = scroller.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message]")]
      .map((row) => ({ id: row.dataset.message ?? "", top: row.getBoundingClientRect().top }))
      .filter((row) => row.top >= view.top)
      .sort((a, b) => a.top - b.top);
    return rows[0]?.id ?? "";
  });
}

test.describe("what it shows", () => {
  test.beforeEach(async ({ page }) => open(page));

  test("the tabs, with the showing conversation's header, voice and box", async ({ page }) => {
    const tabs = page.getByRole("tablist", { name: "Conversations" }).getByRole("tab");
    await expect(tabs).toHaveCount(4);
    for (const [index, name] of ["#general", "#listening-room", "DM with Jules", "#weekend-plans"].entries()) {
      await expect(tabs.nth(index)).toHaveAccessibleName(name);
    }
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel", { name: "#general" });
    await expect(panel.getByRole("heading", { name: "general" })).toBeVisible();
    await expect(panel.locator(".nx-pane-head")).toContainText("Good company. No hurry.");
    const voice = panel.getByRole("group", { name: "Voice in this conversation" });
    await expect(voice).toContainText("Eli");
    await expect(voice).toContainText("are talking");
    await expect(voice.getByRole("button", { name: "Join" })).toBeVisible();
    await expect(box(page)).toHaveAttribute("placeholder", "Say something in #general");
  });

  test("a tab with something new is bold and never shows a number", async ({ page }) => {
    const weight = (name: string) =>
      page
        .getByRole("tab", { name })
        .locator(".k-tab-title")
        .evaluate((title) => Number(getComputedStyle(title).fontWeight));
    expect(await weight("DM with Jules")).toBeGreaterThanOrEqual(600);
    expect(await weight("#weekend-plans")).toBeGreaterThanOrEqual(600);
    expect(await weight("#listening-room")).toBeLessThan(600);
    const numeric = await page.locator(".k-tabs *").evaluateAll((elements) =>
      elements.filter((element) => element.children.length === 0 && /^\s*\d+\s*$/.test(element.textContent ?? "")).length,
    );
    expect(numeric).toBe(0);
  });

  test("the evening in its sessions, with natural dividers", async ({ page }) => {
    await expect(page.locator(".nx-divider")).toHaveText(["last night", "this afternoon", "tonight"], { ignoreCase: true });
    await expect(message(page, "Perfect timing")).toContainText("Eli");
    await expect(message(page, "exactly what I wanted")).toContainText("Matt");
  });

  test("a reply's quote sits above its own line, inside its own message", async ({ page }) => {
    const reply = message(page, "Perfect timing");
    const quote = reply.locator(".nx-quote");
    await expect(quote).toHaveAccessibleName(/^Replying to Jules: Anyone around/);
    const quoteBox = await rect(quote);
    const words = await rect(reply.locator(".nx-text"));
    const name = await rect(reply.locator(".nx-msg-who"));
    expect(quoteBox.y + quoteBox.height).toBeLessThanOrEqual(words.y + 0.5);
    expect(quoteBox.y + quoteBox.height).toBeLessThanOrEqual(name.y + 0.5);
    // It starts at the row's edge, like the name, not under the words.
    expect(Math.abs(quoteBox.x - name.x)).toBeLessThanOrEqual(1);
  });

  test("a link on its own shows as its card; a picture as itself", async ({ page }) => {
    const card = page.getByRole("button", { name: /Millrace River Trail/ });
    await expect(card).toBeVisible();
    await expect(page.locator(".nx-text", { hasText: "millrace-trail.org/river-loop" })).toHaveCount(0);
    await card.click();
    expect(await did(page)).toContain("link:https://millrace-trail.org/river-loop");
  });

  test("the typing line names who is writing, in words", async ({ page }) => {
    await page.getByRole("tab", { name: "#listening-room" }).click();
    await expect(page.locator(".nx-typing")).toHaveText(/Dave\s*is typing/);
  });

  test("the left-off line sits where you stopped reading", async ({ page }) => {
    await page.getByRole("tab", { name: "DM with Jules" }).click();
    const line = page.locator(".nx-left-off");
    await expect(line).toHaveText("you left off here");
    const lineBox = await rect(line);
    const before = await rect(message(page, "record recommendation"));
    const after = await rect(message(page, "porch light"));
    expect(before.y).toBeLessThan(lineBox.y);
    expect(after.y).toBeGreaterThan(lineBox.y);
  });
});

test.describe("built on the system", () => {
  test.beforeEach(async ({ page }) => open(page));

  test("title bar, header, voice strip and box are on the control scale", async ({ page }) => {
    const heights = await page.evaluate(() =>
      [".k-titlebar", ".nx-pane-head", ".nx-strip", ".nx-composer-box"].map(
        (selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0,
      ),
    );
    expect(heights).toEqual([40, 40, 40, 40]);
  });

  test("names start on one edge, and every line of words starts on another", async ({ page }) => {
    const names = await page.locator(".nx-msg[data-head='yes'] .nx-msg-who").evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().x)));
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(1);

    // A continuation's words start where its head's do.
    const head = await rect(message(page, "Found the playlist").locator(".nx-text"));
    const next = await rect(message(page, "Putting it on now").locator(".nx-text"));
    expect(Math.abs(head.x - next.x)).toBeLessThanOrEqual(0.5);

    // A wrapped line starts under the first line's words, not under the name.
    const lines = await message(page, "exactly what I wanted")
      .locator(".nx-text p")
      .evaluate((paragraph) => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const tops = new Map<number, number>();
        for (const box of range.getClientRects()) {
          const top = Math.round(box.top);
          tops.set(top, Math.min(tops.get(top) ?? Infinity, box.left));
        }
        return [...tops.values()];
      });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lines) - Math.min(...lines)).toBeLessThanOrEqual(0.5);
  });

  test("rows sit edge to edge, groups have one gap, and a one-line continuation is 24px", async ({ page }) => {
    const rows = await page.locator(".nx-conv-row").evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => a.top - b.top)
        .map((box) => ({ top: box.top, bottom: box.bottom })),
    );
    for (let index = 1; index < rows.length; index += 1) {
      const [above, below] = [rows[index - 1], rows[index]];
      if (above && below) expect(Math.abs(below.top - above.bottom)).toBeLessThanOrEqual(0.5);
    }
    const heads = await page.locator(".nx-msg[data-head='yes']").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).paddingTop));
    expect(new Set(heads)).toEqual(new Set(["8px"]));
    expect((await rect(message(page, "Putting it on now"))).height).toBe(24);
  });

  test("no text is cut off without an ellipsis, even a name far too long for its place", async ({ page }) => {
    await open(page, "?long");
    const clipped = await page.locator(".nx-chat *").evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element);
          if (style.overflowX !== "hidden" && style.overflow !== "hidden") return false;
          if (!element.textContent?.trim()) return false;
          const wide = element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== "ellipsis";
          const tall = element.scrollHeight > element.clientHeight + 1 && style.overflowY !== "auto";
          return wide || tall;
        })
        .map((element) => `${element.className}: ${element.textContent?.slice(0, 40)}`),
    );
    expect(clipped).toEqual([]);
  });

  test("every control has a name, and the log and box say where they are", async ({ page }) => {
    await expect(log(page)).toHaveAccessibleName("Messages in #general");
    await expect(box(page)).toHaveAccessibleName("Message in #general");
    const unnamed = await page.locator(".nx-chat button").evaluateAll((buttons) =>
      buttons.filter((button) => !(button.getAttribute("aria-label") ?? button.textContent ?? "").trim()).length,
    );
    expect(unnamed).toBe(0);
    await expect(page.getByRole("button", { name: "Open in its own window" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a file" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Emoji" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });
});

test.describe("the keyboard", () => {
  test.beforeEach(async ({ page }) => open(page));

  test("arrows move between tabs and show them; only the showing tab is in the tab order", async ({ page }) => {
    const tabs = page.getByRole("tab");
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "#listening-room" })).toBeFocused();
    await expect(page.getByRole("heading", { name: "listening-room" })).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "#weekend-plans" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "#general" })).toBeFocused();
    const order = await tabs.evaluateAll((all) => all.map((tab) => tab.getAttribute("tabindex")));
    expect(order).toEqual(["0", "-1", "-1", "-1"]);
  });

  test("Enter sends at once and keeps the box; Shift+Enter starts a new line", async ({ page }) => {
    const input = box(page);
    await input.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(input).toHaveValue("first line\nsecond line");
    expect(await did(page)).toEqual([]);
    expect((await rect(page.locator(".nx-composer-box"))).height).toBeGreaterThan(40);

    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    expect(await did(page)).toEqual(["send:first line\nsecond line"]);
    await expect(message(page, "second line")).toBeVisible();
    // Straight on to the next one: the box never waited for the server.
    await page.keyboard.type("and another");
    await page.keyboard.press("Enter");
    await expect(message(page, "and another")).toBeVisible();
    expect((await rect(page.locator(".nx-composer-box"))).height).toBe(40);
  });

  test("typing redraws the box, not the conversation", async ({ page }) => {
    await page.evaluate(() => {
      const rows = document.querySelector(".nx-conv-rows");
      const seen = { count: 0 };
      (window as unknown as { seen: typeof seen }).seen = seen;
      if (rows) new MutationObserver((changes) => (seen.count += changes.length)).observe(rows, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await box(page).click();
    await page.keyboard.type("typing along without moving anything", { delay: 5 });
    expect(await page.evaluate(() => (window as unknown as { seen: { count: number } }).seen.count)).toBe(0);
  });

  test("each tab keeps its own draft while the window is open", async ({ page }) => {
    await box(page).fill("half a thought");
    await page.getByRole("tab", { name: "#listening-room" }).click();
    await expect(box(page)).toHaveValue("");
    await page.getByRole("tab", { name: "#general" }).click();
    await expect(box(page)).toHaveValue("half a thought");
  });

  test("Up in an empty box edits your last message; Enter saves it", async ({ page }) => {
    await box(page).click();
    await page.keyboard.press("ArrowUp");
    const edit = page.getByRole("textbox", { name: /Edit/ });
    await expect(edit).toBeFocused();
    // The edit box is taller than the line it replaces; the end stays in view.
    await expect(message(page, "Putting it on now")).toBeInViewport({ ratio: 1 });
    await expect(edit).toHaveValue("Count me in. Let's put the details in #weekend-plans when we know.");
    await edit.fill("Count me in.");
    await page.keyboard.press("Enter");
    await expect(message(page, /^Matt:\s*Count me in\.edited/)).toBeVisible();
    expect(await did(page)).toContain("save:m000014:Count me in.");
    // Straight back to the box, to carry on.
    await expect(box(page)).toBeFocused();
  });
});

test.describe("emoji", () => {
  test.beforeEach(async ({ page }) => open(page));

  test("a picked emoji goes in at the caret, and the box keeps focus", async ({ page }) => {
    await box(page).fill("porch light ");
    await page.getByRole("button", { name: "Emoji" }).click();
    const panel = page.getByRole("dialog", { name: "Emoji" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button").first().click();
    await expect(panel).toHaveCount(0);
    await expect(box(page)).toBeFocused();
    expect(await box(page).inputValue()).toMatch(/^porch light \p{Extended_Pictographic}/u);
  });

  test("Escape or a click elsewhere closes the panel", async ({ page }) => {
    const panel = page.getByRole("dialog", { name: "Emoji" });
    await page.getByRole("button", { name: "Emoji" }).click();
    await panel.getByRole("button").first().focus();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(box(page)).toBeFocused();
    await page.getByRole("button", { name: "Emoji" }).click();
    await log(page).click({ position: { x: 20, y: 20 } });
    await expect(panel).toHaveCount(0);
  });
});

test.describe("the row menu", () => {
  test.beforeEach(async ({ page }) => open(page));

  test("replies, and the reply goes out with its quote", async ({ page }) => {
    const row = message(page, "No plans, no agenda");
    await row.hover();
    await row.getByRole("button", { name: "Actions for Eli's message" }).click();
    const menu = page.getByRole("menu", { name: "Actions for Eli's message" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Reply", "Delete"]);
    await expect(menu.getByRole("menuitem", { name: "Reply" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".nx-composer-reply")).toContainText("Replying to Eli");
    await expect(box(page)).toBeFocused();
    // The reply line takes room from the conversation, never the newest line.
    await expect(message(page, "Putting it on now")).toBeInViewport({ ratio: 1 });
    await page.keyboard.type("same");
    await page.keyboard.press("Enter");
    await expect(page.locator(".nx-composer-reply")).toHaveCount(0);
    await expect(page.locator(".nx-msg", { has: page.locator(".nx-text", { hasText: /^same$/ }) }).locator(".nx-quote")).toHaveAccessibleName(
      /^Replying to Eli: No plans/,
    );
  });

  test("deletes only after asking, and Escape puts focus back", async ({ page }) => {
    const row = message(page, "Found the playlist");
    await row.hover();
    const trigger = row.getByRole("button", { name: "Actions for Eli's message" });
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Delete for good", "Keep it"]);
    await page.getByRole("menuitem", { name: "Delete for good" }).click();
    await expect(page.locator("[data-message='m000015']")).toContainText("deleted");
  });

  test("a quote takes you to the message it answers", async ({ page }) => {
    await message(page, "A bit of Khruangbin").locator(".nx-quote").click();
    const target = page.locator("[data-message='m000005']");
    await expect(target).toHaveAttribute("data-flash", "yes");
    await expect(target).toBeInViewport();
  });

  test("a picture opens over the window and closes with Escape", async ({ page }) => {
    await page.getByRole("button", { name: "Open speakers.png" }).click();
    const viewer = page.getByRole("dialog", { name: "speakers.png" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Close the picture" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open speakers.png" })).toBeFocused();
  });
});

test.describe("a send the server refuses", () => {
  test("goes back into an untouched box, with the reason", async ({ page }) => {
    await open(page, "?fail");
    await box(page).click();
    await page.keyboard.type("hello?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".nx-composer-problem")).toHaveText(/Couldn't reach the server/);
    await expect(box(page)).toHaveValue("hello?");
    await expect(page.getByRole("group", { name: "Unsent message" })).toHaveCount(0);
  });

  test("waits apart with a retry when you've already typed the next thing", async ({ page }) => {
    await open(page, "?fail");
    await box(page).click();
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second, still typing");
    const unsent = page.getByRole("group", { name: "Unsent message" });
    await expect(unsent).toContainText("first");
    await expect(box(page)).toHaveValue("second, still typing");
    await unsent.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => (await did(page)).filter((one) => one === "send:first").length).toBe(2);
  });
});

test.describe("voice here", () => {
  test("in voice here: your mute, deafen and leave, as symbols, and nothing to join (#216)", async ({ page }) => {
    await open(page, "?voice=mine");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await expect(strip.getByRole("listitem")).toHaveText(["you", "Eli", "Jules"]);
    await expect(strip.getByRole("group", { name: "Your voice" }).getByRole("button")).toHaveText(["", "", ""]);
    await expect(strip.getByRole("button", { name: /Join|Move|Start/ })).toHaveCount(0);
    await strip.getByRole("button", { name: "Mute" }).click();
    expect(await did(page)).toEqual(["mute"]);
  });

  test("in voice elsewhere: offers to move, in words", async ({ page }) => {
    await open(page, "?voice=elsewhere");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await strip.getByRole("button", { name: "Move voice here" }).click();
    expect(await did(page)).toEqual(["join"]);
    await page.getByRole("tab", { name: "#weekend-plans" }).click();
    await expect(strip).toContainText("Nobody's talking in here.");
    await expect(strip.getByRole("button", { name: "Talk here instead" })).toBeVisible();
  });

  test("nobody in voice: offers to start, and the strip keeps its height", async ({ page }) => {
    await open(page, "?voice=off");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await expect(strip.getByRole("button", { name: "Start talking" })).toBeVisible();
    expect((await rect(strip)).height).toBe(40);
  });
});

test.describe("reading and arriving", () => {
  test("5,000 messages draw only what is near the view", async ({ page }) => {
    await open(page, "?big");
    await expect(message(page, "(5000)")).toBeInViewport();
    expect(await page.locator(".nx-conv-row").count()).toBeLessThan(80);
    await log(page).evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(page.locator(".nx-text", { hasText: /\(1\)$/ })).toBeVisible();
    expect(await page.locator(".nx-conv-row").count()).toBeLessThan(80);
  });

  test("a new message while you read older ones does not move what you're reading", async ({ page }) => {
    await open(page, "?big");
    await expect(message(page, "(5000)")).toBeInViewport();
    await log(page).evaluate((element) => element.scrollBy({ top: -1500 }));
    await page.waitForTimeout(200);
    const reading = await firstInView(page);
    const before = await offsetIn(page, reading);
    await page.evaluate(() => window.chat?.arrive("r-general", "u-dave", "did anyone see the moon tonight"));
    await expect(page.getByRole("button", { name: "Back to the newest" })).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(Math.abs((await offsetIn(page, reading)) - before)).toBeLessThanOrEqual(1);
    await expect(message(page, "did anyone see the moon")).not.toBeInViewport();
  });

  test("at the bottom, a new message comes into view", async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.chat?.arrive("r-general", "u-dave", "late one from Dave"));
    await expect(message(page, "late one from Dave")).toBeInViewport();
  });

  test("older history arrives above without moving what you're reading", async ({ page }) => {
    await open(page, "?big&paged");
    await expect(message(page, "(5000)")).toBeInViewport();
    const tall = () => page.locator(".nx-conv-rows").evaluate((rows) => rows.getBoundingClientRect().height);
    const heldBefore = await tall();
    await log(page).evaluate((element) => element.scrollTo({ top: 400 }));
    await page.waitForTimeout(100);
    const reading = await firstInView(page);
    const before = await offsetIn(page, reading);
    await expect.poll(async () => (await did(page)).some((one) => one.startsWith("older:"))).toBe(true);
    await expect.poll(tall).toBeGreaterThan(heldBefore);
    await page.waitForTimeout(300);
    expect(Math.abs((await offsetIn(page, reading)) - before)).toBeLessThanOrEqual(1);
  });
});

test.describe("a file to download", () => {
  const card = (page: Page) => page.locator(".nx-att-card", { hasText: "river-loop-trail-map.pdf" });

  test("goes to the browser, and says so without claiming it was saved; the address is there to copy", async ({ page }) => {
    await open(page, "?file");
    await expect(card(page)).toContainText("2.0 MB");
    await card(page).getByRole("button", { name: "Download" }).click();
    await expect.poll(() => did(page)).toContain("download:river-loop-trail-map.pdf");
    await expect(card(page).getByRole("status")).toHaveText("Your browser has it: look in its downloads. If nothing opened, copy this address into it.");
    await expect(card(page).getByRole("textbox", { name: "Address of river-loop-trail-map.pdf" })).toHaveValue(/\/media\/river-loop-trail-map\.pdf$/);
    await expect(card(page)).not.toContainText("saved");
  });

  test("a browser that won't open says so, offers another go, and the address", async ({ page }) => {
    await open(page, "?file&downloadfail");
    await card(page).getByRole("button", { name: "Download" }).click();
    await expect(card(page).getByRole("alert")).toHaveText("Couldn't open your browser. Try again, or copy this address into it.");
    const again = card(page).getByRole("button", { name: "Try again" });
    await expect(again).toBeEnabled();
    await expect(card(page).getByRole("textbox", { name: "Address of river-loop-trail-map.pdf" })).toBeVisible();
    await again.click();
    await expect(card(page).getByRole("alert")).toBeVisible();
  });
});
