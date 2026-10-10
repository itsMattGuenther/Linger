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
  return page.getByRole("combobox", { name: /^Message/ });
}

/** The row holding a message, found by its words. */
function message(page: Page, words: string | RegExp): Locator {
  return page.locator(".nx-msg", { hasText: words });
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

  test("a DM's tab with something new is lit as well as bold; a room's is bold only (#291)", async ({ page }) => {
    const jules = page.getByRole("tab", { name: "DM with Jules" }).locator("xpath=..");
    const plans = page.getByRole("tab", { name: "#weekend-plans" }).locator("xpath=..");
    await expect(jules).toHaveAttribute("data-lit", "yes");
    await expect(plans).toHaveAttribute("data-fresh", "yes");
    await expect(plans).not.toHaveAttribute("data-lit", "yes");
    const [lit, plain] = await Promise.all([jules, plans].map((tab) => tab.evaluate((node) => getComputedStyle(node).backgroundColor)));
    expect(lit).not.toBe(plain);
    // Showing it, it's being read: no longer lit.
    await page.getByRole("tab", { name: "DM with Jules" }).click();
    await expect(jules).not.toHaveAttribute("data-lit", "yes");
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

  test("names start on one edge, and every line of words starts on another, 16px in (#295)", async ({ page }) => {
    const names = await page.locator(".nx-msg[data-head='yes'] .nx-msg-who").evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().x)));
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(1);

    // Every message's words start on one edge, whoever wrote them and
    // however long their name is: the head of a run and the rest of it alike.
    const words = await page.locator(".nx-msg .nx-text").evaluateAll((texts) => texts.map((text) => Math.round(text.getBoundingClientRect().x * 2) / 2));
    expect(words.length).toBeGreaterThan(8);
    expect(new Set(words).size).toBe(1);
    const indent = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-4")));
    expect((words[0] ?? 0) - (names[0] ?? 0)).toBeCloseTo(indent, 0);

    // The name has a line of its own: the words start under it, not beside it.
    const head = message(page, "Found the playlist");
    const who = await rect(head.locator(".nx-msg-who"));
    const said = await rect(head.locator(".nx-text"));
    expect(who.y + who.height).toBeLessThanOrEqual(said.y + 0.5);
    // A later message in the run has no name at all, and no colon anywhere.
    await expect(message(page, "Putting it on now").locator(".nx-msg-who")).toHaveCount(0);
    expect(await page.locator(".nx-msg").evaluateAll((rows) => rows.some((row) => /^\s*:/.test(row.querySelector(".nx-msg-body")?.textContent ?? "")))).toBe(false);
    await expect(page.locator(".nx-msg-colon")).toHaveCount(0);

    // A continuation's words start where its head's do.
    const next = await rect(message(page, "Putting it on now").locator(".nx-text"));
    expect(Math.abs(said.x - next.x)).toBeLessThanOrEqual(0.5);

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

  for (const width of [780, 420, 360]) {
    test(`a name far too long moves nobody's words, and shows whole where it fits, at ${width} (#295)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 790 });
      await open(page, "?long");
      const words = await page.locator(".nx-msg .nx-text").evaluateAll((texts) => texts.map((text) => Math.round(text.getBoundingClientRect().x * 2) / 2));
      expect(new Set(words).size).toBe(1);
      const eli = page.locator(".nx-msg[data-head='yes'] .nx-msg-who").filter({ has: page.locator(".k-name") }).first();
      await expect(eli).toBeVisible();
      // The name's own box never runs past the row, and it's cut only when
      // the line itself is too narrow for it.
      const fit = await page.locator(".nx-msg[data-head='yes'] .nx-msg-who .k-name").evaluateAll((names) =>
        names.map((name) => {
          const row = name.closest(".nx-msg")?.getBoundingClientRect();
          const box = name.getBoundingClientRect();
          return { inside: row !== undefined && box.right <= row.right + 0.5, cut: name.scrollWidth > name.clientWidth + 1 };
        }),
      );
      expect(fit.every((one) => one.inside)).toBe(true);
      // Inline, it was cut at 14em wherever it was; on a line of its own it
      // shows whole in the chat window at its usual width.
      if (width === 780) expect(fit.some((one) => one.cut)).toBe(false);
    });
  }

  // A message's words run to its time column, however wide the window: the
  // 80-character limit left most of a wide row empty beside a long message
  // (#334, CONV-7). At 780 wide the words already filled the line; they
  // still do.
  for (const scale of [1, 2])
    for (const width of [780, 1600])
      test(`at ${scale * 100}%, ${width} wide, a long message's words run to its time column (CONV-7, #334)`, async ({ browser }) => {
        const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: scale });
        await open(page);
        const words = "the porch light is on and the kettle is warm, come sit a while ".repeat(12).trim();
        await page.evaluate((body) => window.chat?.arrive("r-general", "u-dave", body), words);
        const row = message(page, "the porch light is on");
        await expect(row.locator(".nx-text")).toBeInViewport();
        const laid = await row.evaluate((node) => {
          const text = node.querySelector(".nx-text");
          const time = node.querySelector(".nx-msg-time");
          if (!text || !time) throw new Error("no words or no time");
          const range = document.createRange();
          range.selectNodeContents(text);
          const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
          const probe = document.createElement("span");
          probe.textContent = "0".repeat(80);
          probe.style.font = getComputedStyle(text).font;
          probe.style.position = "absolute";
          probe.style.whiteSpace = "pre";
          document.body.append(probe);
          const eighty = probe.getBoundingClientRect().width;
          probe.remove();
          const box = text.getBoundingClientRect();
          return {
            box: { left: box.left, right: box.right },
            timeLeft: time.getBoundingClientRect().left,
            gap: Number.parseFloat(getComputedStyle(node).columnGap),
            widest: Math.max(...lines.map((line) => line.right)) - box.left,
            tops: new Set(lines.map((line) => Math.round(line.top))).size,
            eighty,
          };
        });
        // The words' box ends where the time column's gap begins, not short of it...
        expect(Math.abs(laid.timeLeft - laid.gap - laid.box.right)).toBeLessThan(1);
        // ...and its lines use it: they wrap, and the widest comes within about
        // a word of the edge.
        expect(laid.tops).toBeGreaterThan(1);
        expect(laid.widest).toBeGreaterThan(laid.box.right - laid.box.left - 80);
        if (width === 1600) expect(laid.widest).toBeGreaterThan(laid.eighty + 100);
        await page.close();
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
    await expect(message(page, /^Matt\s*Count me in\.edited/)).toBeVisible();
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
    // The first emoji in the grid (#359): the picker's search, tone and tabs come before it.
    await panel.getByRole("region", { name: "Smileys & emotion" }).getByRole("button").first().click();
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

test.describe("the message box", () => {
  test.beforeEach(async ({ page }) => open(page));

  // Dictation and paste tools put text in whole rather than key by key.
  // A regression guard at the browser level, not a test of those tools.
  test("text put in whole stays as it came, on several lines, and doesn't send", async ({ page }) => {
    await box(page).focus();
    const text = "Café — hello 👋\nA second line, still a draft.";
    await page.keyboard.insertText(text);
    await expect(box(page)).toHaveValue(text);
    expect((await did(page)).filter((line) => line.startsWith("send:"))).toEqual([]);
  });

  test("Add a file opens the file picker and keeps what's typed", async ({ page }) => {
    await box(page).fill("keep this draft");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add a file" }).click();
    expect((await chooser).isMultiple()).toBe(true);
    await expect(box(page)).toHaveValue("keep this draft");
  });

  test("the box grows with its lines and shrinks back, and its buttons keep their size by the last line", async ({ page }) => {
    const shape = () =>
      page.locator(".nx-composer-box").evaluate((node) => {
        const frame = node.getBoundingClientRect();
        const send = node.querySelector("[aria-label='Send']")?.getBoundingClientRect();
        const add = node.querySelector("[aria-label='Add a file']")?.getBoundingClientRect();
        if (!send || !add) throw new Error("no buttons");
        return { height: frame.height, send: send.height, add: add.height, sendBelow: frame.bottom - send.bottom, addBelow: frame.bottom - add.bottom };
      });
    await box(page).fill("one line");
    const one = await shape();
    await box(page).fill("first line\nsecond line\nthird line");
    await expect.poll(async () => (await shape()).height).toBeGreaterThan(one.height);
    const three = await shape();
    expect({ send: three.send, add: three.add, sendBelow: three.sendBelow, addBelow: three.addBelow }).toEqual({
      send: one.send,
      add: one.add,
      sendBelow: one.sendBelow,
      addBelow: one.addBelow,
    });
    await box(page).fill("one line again");
    await expect.poll(async () => (await shape()).height).toBe(one.height);
  });

  // #478: on Windows (WebView2, Chromium) the box's hint could be selected
  // like words. Selecting the whole window is the sure way to show it.
  test("selecting the whole window leaves the box and its hint as they were, and skips the prompt", async ({ page }) => {
    await expect(box(page)).toHaveAttribute("placeholder", /^Say something/);
    await log(page).focus();
    const before = await box(page).screenshot();
    await page.keyboard.press("ControlOrMeta+a");
    expect(await page.evaluate(() => String(getSelection()))).toContain("drop into voice");
    expect((await box(page).screenshot()).equals(before)).toBe(true);
    expect(await page.evaluate(() => String(getSelection()))).not.toContain("›");
  });

  test("your own selection in the box still shows", async ({ page }) => {
    await box(page).fill("a draft to select");
    const before = await box(page).screenshot({ caret: "hide" });
    await page.keyboard.press("ControlOrMeta+a");
    expect((await box(page).screenshot({ caret: "hide" })).equals(before)).toBe(false);
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

  test("a picture is drawn from the server's smaller copy and opens whole (#382)", async ({ page }) => {
    const copy = page.getByRole("button", { name: "Open speakers.png" }).locator("img");
    expect(decodeURIComponent((await copy.getAttribute("src")) ?? "")).toContain("<title>display copy</title>");
    await page.getByRole("button", { name: "Open speakers.png" }).click();
    const whole = page.getByRole("dialog", { name: "speakers.png" }).locator("img");
    await expect(whole).toBeVisible();
    expect(decodeURIComponent((await whole.getAttribute("src")) ?? "")).not.toContain("display copy");
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
    // The refusal waits for the test, so the next thing is surely typed
    // first: on a 120 ms timer a busy machine sometimes typed it after, and
    // the refusal found an empty box (#341).
    await open(page, "?fail=held");
    await box(page).click();
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second, still typing");
    await expect(box(page)).toHaveValue("second, still typing");
    await page.evaluate(() => window.chat?.refuse());
    const unsent = page.getByRole("group", { name: "Unsent message" });
    await expect(unsent).toContainText("first");
    await expect(box(page)).toHaveValue("second, still typing");
    await unsent.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => (await did(page)).filter((one) => one === "send:first").length).toBe(2);
  });
});

test.describe("voice here", () => {
  for (const [width, height] of [[780, 790], [480, 360]] as const) {
    test(`the voice strip's tooltips show whole at ${width} by ${height} (#140)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, "?voice=mine");
      const yours = page.getByRole("group", { name: "Voice in this conversation" }).getByRole("group", { name: "Your voice" });
      for (const name of ["Mute", "Deafen", "Leave voice"]) {
        await expectWholeTooltip(page, yours.getByRole("button", { name, exact: true }), name);
      }
    });
  }

  test("in voice here: your mute, deafen and leave, as symbols, and nothing to join (#216)", async ({ page }) => {
    await open(page, "?voice=mine");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await expect(strip.getByRole("listitem")).toHaveText(["you", "Eli", "Jules"]);
    await expect(strip.getByRole("group", { name: "Your voice" }).getByRole("button")).toHaveText(["", "", ""]);
    await expect(strip.getByRole("button", { name: /Join|Move|Start/ })).toHaveCount(0);
    await strip.getByRole("button", { name: "Mute" }).click();
    expect(await did(page)).toEqual(["mute"]);
  });

  // A raid (#197): more people than the strip has chips. In the room you're
  // in, it shows you and whoever just talked, still while they talk.
  test("in a big room you're in, the strip shows you and whoever just talked, and nobody moves while they talk", async ({ page }) => {
    await open(page, "?voice=mine&raid");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    const chips = strip.getByRole("list", { name: "In voice here" }).getByRole("listitem");
    // Eli was talking as it opened; the others are the first to join.
    await expect(chips).toHaveText(["you", "Eli", "Jules", "Kestrel"]);
    await expect(strip).toContainText("and others");
    await page.evaluate(() => window.chat?.talk(["u-raid-12"]));
    await expect(chips).toHaveText(["you", "Eli", "Fennick", "Kestrel"]);
    await expect(chips.filter({ hasText: "Fennick" }).locator("[data-kit='Chip']")).toHaveAttribute("data-active", "yes");
    await page.evaluate(() => window.chat?.talk([]));
    await expect(chips).toHaveText(["you", "Eli", "Fennick", "Kestrel"]);
    // Somebody new: the seat of whoever spoke longest ago (Kestrel never did).
    await page.evaluate(() => window.chat?.talk(["u-raid-30"]));
    await expect(chips).toHaveText(["you", "Eli", "Fennick", "Yarrow"]);
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

  // A server whose host hasn't set voice up carries none (#306): the strip
  // says so, plainly, keeps its height, and offers no way in.
  test("on a server without voice: says it isn't set up, and offers nothing", async ({ page }) => {
    await open(page, "?voice=off");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    const usual = await rect(strip);
    await open(page, "?voice=none");
    await expect(strip).toHaveText("Voice isn't set up on this server.");
    await expect(strip.getByRole("button")).toHaveCount(0);
    expect((await rect(strip)).height).toBe(usual.height);
  });

  // Starting voice used to fail with nothing to show for it: the strip
  // blinked and went back (#261). It says why now, on its one line.
  test("taken out by the host, the strip says so, and Join is still there (#423)", async ({ page }) => {
    await open(page, "?voice=elsewhere&tab=r-general&takenout");
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await expect(strip.getByRole("status")).toHaveText("You were taken out of voice.");
    await expect(strip.getByRole("button", { name: /Join|Start talking|Move/ })).toBeVisible();
  });

  test("a start that failed says why, keeps the strip's height, and offers another try (#261)", async ({ page }) => {
    const reason = "the microphone wouldn't open: Permission denied. Grant the required access and retry.";
    await page.goto(`/tests/fixtures/next-chat.html?voice=off&windows&voicefail=${encodeURIComponent(reason)}`);
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    const said = strip.getByRole("alert");
    await expect(said).toHaveText("Couldn't start voice. Windows' privacy settings are blocking the microphone.");
    await expect(said).toHaveAttribute("title", `Couldn't start voice. Windows' privacy settings are blocking the microphone.\n${reason}`);
    await expect(strip).not.toContainText("Nobody's talking in here.");
    // Picking a device wouldn't fix this one, so there's nothing to pick (#273).
    await expect(strip.getByRole("button", { name: "Pick yours in Settings" })).toHaveCount(0);
    await expect(strip.getByRole("button", { name: "Start talking" })).toBeVisible();
    expect((await rect(strip)).height).toBe(40);
    // It stays on one line, and doesn't push the button out.
    const words = await said.evaluate((node) => ({ lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), right: node.getBoundingClientRect().right }));
    const button = await rect(strip.getByRole("button", { name: "Start talking" }));
    expect(words.lines).toBe(1);
    expect(words.right).toBeLessThanOrEqual(button.x);
  });

  // A friend couldn't read why voice didn't start: the strip cut it off and
  // the whole of it was only a tooltip, gone when the mouse moved, which
  // nothing could copy (#399). A click opens it whole, in a card that stays,
  // and Copy takes both lines for the host.
  test("the reason voice didn't start opens whole, stays, and copies for the host (#399)", async ({ page }) => {
    const reason = "the speakers wouldn't open: Failed to initialize audio client: The parameter is incorrect. (os error -2147024809)";
    await page.addInitScript(() => {
      const copied: string[] = [];
      Object.assign(window, { copied, refuse: false });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if ((window as unknown as { refuse: boolean }).refuse) throw new Error("refused");
            copied.push(text);
          },
        },
      });
    });
    await page.goto(`/tests/fixtures/next-chat.html?voice=off&windows&voicefail=${encodeURIComponent(reason)}`);
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await strip.getByRole("alert").getByRole("button").click();
    const card = page.getByRole("dialog", { name: "Why voice didn't start" });
    await expect(card).toBeVisible();
    const lead = "Couldn't start voice. Windows' default speakers wouldn't open. Pick yours in Settings.";
    await expect(card).toContainText(lead);
    await expect(card).toContainText(reason);
    // Copy has the focus, and takes Linger's sentence and the shell's words together.
    const copy = card.getByRole("button", { name: "Copy" });
    await expect(copy).toBeFocused();
    await copy.click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([`${lead}\n${reason}`]);
    // Still there after the mouse has moved on.
    await page.mouse.move(5, 5);
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // A clipboard that won't take it says so, rather than claiming "Copied".
    await page.evaluate(() => Object.assign(window, { refuse: true }));
    await strip.getByRole("alert").getByRole("button").click();
    await card.getByRole("button", { name: "Copy" }).click();
    await expect(card.getByRole("status")).toHaveText("The clipboard wouldn't take it. Select the words above and copy them instead.");
    await expect(card.getByRole("button", { name: "Copied" })).toHaveCount(0);
    // A press anywhere else closes it.
    await page.mouse.click(5, 5);
    await expect(card).toHaveCount(0);
  });

  // The Windows 10 friend's default microphone wouldn't open; picking his by
  // name in Settings fixed it (#273). The strip says so on its one line, at
  // the chat window's narrowest and a conversation window's, with the fix as
  // a button that is never cut off: the words give way first.
  for (const width of [420, 360]) {
    test(`a default device that wouldn't open says to pick yours, whole, ${width} wide (#273)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 790 });
      const reason = "the microphone wouldn't open: The requested device could not be opened.";
      await page.goto(`/tests/fixtures/next-chat.html?voice=off&windows&voicefail=${encodeURIComponent(reason)}`);
      await page.evaluate(() => document.fonts.ready);
      const strip = page.getByRole("group", { name: "Voice in this conversation" });
      const said = strip.getByRole("alert");
      await expect(said).toHaveText("Couldn't start voice. Windows' default microphone wouldn't open.");
      await expect(said).toHaveAttribute("title", `Couldn't start voice. Windows' default microphone wouldn't open. Pick yours in Settings.\n${reason}`);
      const pick = strip.getByRole("button", { name: "Pick yours in Settings" });
      const start = strip.getByRole("button", { name: "Start talking" });
      await expect(pick).toBeVisible();
      await expect(start).toBeVisible();
      expect((await rect(strip)).height).toBe(40);
      // One line: the words, then the fix whole, then Start talking, all inside the strip.
      const words = await said.evaluate((node) => ({ lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), right: node.getBoundingClientRect().right }));
      const label = await pick.locator(".k-button-label").evaluate((node) => node.scrollWidth - node.clientWidth);
      const [edge, fix, again] = [await rect(strip), await rect(pick), await rect(start)];
      expect(words.lines).toBe(1);
      expect(words.right).toBeLessThanOrEqual(fix.x);
      expect(label).toBe(0);
      expect(fix.x + fix.width).toBeLessThanOrEqual(again.x);
      expect(again.x + again.width).toBeLessThanOrEqual(edge.x + edge.width);
      expect(fix.y).toBe(again.y);
      // It opens Settings on Sound & Voice.
      await pick.click();
      expect(await did(page)).toEqual(["settings:sound"]);
    });
  }

  test("a device picked by name that wouldn't open says only that (#273)", async ({ page }) => {
    const reason = "the speakers wouldn't open: The requested device could not be opened.";
    await page.goto(`/tests/fixtures/next-chat.html?voice=off&picked&voicefail=${encodeURIComponent(reason)}`);
    const strip = page.getByRole("group", { name: "Voice in this conversation" });
    await expect(strip.getByRole("alert")).toHaveText("Couldn't start voice. The speakers wouldn't open.");
    await expect(strip.getByRole("button", { name: "Pick yours in Settings" })).toHaveCount(0);
    await expect(strip.getByRole("button", { name: "Start talking" })).toBeVisible();
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

  // Every message row formats its full date once per render, for the tooltip
  // on its time, and nothing else in the chat window uses that format.
  // Counting those calls counts row renders without instrumenting the app.
  test("scrolling re-renders only the rows coming into view (PERF-2, #170)", async ({ page }) => {
    await page.addInitScript(() => {
      const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
      if (!format?.get) throw new Error("Intl.DateTimeFormat#format is not a getter here");
      const read = format.get;
      Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
        configurable: true,
        get(this: Intl.DateTimeFormat) {
          const bound = read.call(this) as (date?: Date | number) => string;
          if (this.resolvedOptions().dateStyle !== "full") return bound;
          return (date?: Date | number) => {
            const counted = window as unknown as { rowRenders?: number };
            counted.rowRenders = (counted.rowRenders ?? 0) + 1;
            return bound(date);
          };
        },
      });
    });
    await open(page, "?big");
    await expect(message(page, "(5000)")).toBeInViewport();
    await log(page).evaluate((element) => element.scrollBy({ top: -600 }));
    // Let the scroll and the rows' measuring settle before counting.
    await page.waitForTimeout(800);
    const result = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>(".nx-conv-scroll");
      if (!scroller) throw new Error("no scroller");
      const drawn = () => new Set([...document.querySelectorAll<HTMLElement>("[data-message]")].map((row) => row.dataset.message));
      const before = drawn();
      const counted = window as unknown as { rowRenders?: number };
      counted.rowRenders = 0;
      const startTop = scroller.scrollTop;
      // Twenty-five small wheel-sized steps: each re-renders the list, and
      // only a handful of rows come into view across all of them.
      const seen = new Set(before);
      for (let step = 0; step < 25; step += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        scroller.scrollTop -= 4;
        for (const id of drawn()) seen.add(id);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const id of drawn()) seen.add(id);
      return { renders: counted.rowRenders ?? 0, arrived: seen.size - before.size, moved: startTop - scroller.scrollTop, drawn: before.size };
    });
    expect(result.moved, "the log actually scrolled").toBeGreaterThan(40);
    // Unmemoized, every drawn row re-renders on every step: 25 × the drawn
    // rows. A minute tick can re-render the drawn rows once, hence the
    // allowance.
    expect(result.renders).toBeLessThanOrEqual(result.arrived + result.drawn + 5);
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

  test("resizing the window while you read older ones keeps your place, and no rows overlap", async ({ page }) => {
    await open(page, "?big");
    await expect(message(page, "(5000)")).toBeInViewport();
    await log(page).evaluate((element) => element.scrollBy({ top: -1500 }));
    await page.waitForTimeout(200);
    const reading = await firstInView(page);
    const overlaps = () =>
      page.locator(".nx-conv-row").evaluateAll((rows) => {
        const boxes = rows.map((row) => row.getBoundingClientRect()).sort((a, b) => a.top - b.top);
        return boxes.slice(1).filter((box, index) => box.top < (boxes[index]?.bottom ?? 0) - 0.5).length;
      });
    for (const [width, height] of [[520, 500], [1100, 700], [780, 790]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      await expect(page.locator(`[data-message="${reading}"]`), `${width} by ${height}`).toBeInViewport();
      await expect(message(page, "(5000)")).not.toBeInViewport();
      expect(await overlaps(), `${width} by ${height}`).toBe(0);
    }
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
