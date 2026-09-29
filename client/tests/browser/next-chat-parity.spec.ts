import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// The conversation's items in docs/design/parity.md that had no test in the
// new client, proved on the real chat window (tests/fixtures/next-chat-parity.tsx):
// the real ChatWindow, store and sharing code on a fake desktop and server.

test.use({ viewport: { width: 780, height: 820 } });

const SERVER = "https://good-company.example";
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;

async function open(page: Page, query = "room=r-general") {
  await page.route(`${SERVER}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.goto(`/tests/fixtures/next-chat-parity.html?${query}`);
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

function intents(asked: string[]): Record<string, unknown>[] {
  return asked.filter((line) => line.startsWith("intent:")).map((line) => JSON.parse(line.slice("intent:".length)) as Record<string, unknown>);
}

const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const log = (page: Page) => page.getByRole("log");
/** The row of the message with this id. */
const row = (page: Page, id: string) => page.locator(`[data-message="${id}"]`);

async function post(page: Page, body: string, author = "u-eli", extra: Record<string, unknown> = {}): Promise<string> {
  const id = await page.evaluate(([words, who, more]) => window.parity?.post("r-general", who, words, more) ?? "", [body, author, extra] as const);
  await expect(row(page, id)).toBeVisible();
  return id;
}

// A long message folds (#304): a message's words drawn taller than twenty
// lines show the first twenty, fading out, with Show all under them.
test.describe("a long message folds", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
  const drawn = (page: Page, id: string) =>
    row(page, id).evaluate((node) => {
      const fold = node.querySelector<HTMLElement>(".nx-msg-fold");
      const style = fold ? getComputedStyle(fold) : null;
      const line = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--line-body"));
      return {
        lines: fold ? Math.round(fold.getBoundingClientRect().height / line) : 0,
        mask: style?.maskImage ?? style?.webkitMaskImage ?? "",
        text: fold?.textContent ?? "",
      };
    });
  /** No row overlaps the next one, once the rows have been measured. */
  const edgeToEdge = (page: Page) =>
    page.locator(".nx-conv-row").evaluateAll((rows) =>
      rows
        .map((one) => one.getBoundingClientRect())
        .sort((a, b) => a.top - b.top)
        .every((box, i, all) => i === 0 || Math.abs(box.top - (all[i - 1]?.bottom ?? box.top)) <= 0.5),
    );

  test("past twenty lines it folds, fading out, with Show all; all of it is still there, and Show less folds it again (#304)", async ({ page }) => {
    await open(page);
    const id = await post(page, lines(300));
    const after = await post(page, "lol what was that", "u-jules");
    const folded = await drawn(page, id);
    expect(folded.lines).toBe(20);
    expect(folded.mask).not.toBe("none");
    // Nothing is taken out: a screen reader and copying get every line.
    expect(folded.text).toContain("line 300");
    const showAll = row(page, id).getByRole("button", { name: "Show all" });
    await expect(showAll).toBeVisible();
    await expect.poll(() => edgeToEdge(page)).toBe(true);

    await showAll.click();
    await expect(row(page, id).getByRole("button", { name: "Show less" })).toBeVisible();
    await expect.poll(async () => (await drawn(page, id)).lines).toBe(300);
    expect((await drawn(page, id)).mask).toBe("none");
    await expect.poll(() => edgeToEdge(page)).toBe(true);

    await row(page, id).getByRole("button", { name: "Show less" }).click();
    await expect.poll(async () => (await drawn(page, id)).lines).toBe(20);
    await expect.poll(() => edgeToEdge(page)).toBe(true);
    await expect(row(page, after)).toContainText("lol what was that");
  });

  test("a long paragraph with no line breaks folds too; a short message doesn't fold (#304)", async ({ page }) => {
    await open(page);
    const paragraph = await post(page, "word ".repeat(1500).trim());
    expect((await drawn(page, paragraph)).lines).toBe(20);
    await expect(row(page, paragraph).getByRole("button", { name: "Show all" })).toBeVisible();
    // Twenty lines exactly is not over twenty: no fold.
    for (const body of ["just a few words", lines(3), lines(20)]) {
      const id = await post(page, body);
      await expect(row(page, id).getByRole("button", { name: /Show (all|less)/ })).toHaveCount(0);
      expect((await drawn(page, id)).mask).toBe("none");
    }
  });

  test("unfolded stays unfolded after scrolling far away and back (#304)", async ({ page }) => {
    await open(page, "room=r-general&many=600");
    const id = await post(page, lines(120));
    await row(page, id).getByRole("button", { name: "Show all" }).click();
    await expect(row(page, id).getByRole("button", { name: "Show less" })).toBeVisible();
    // Far enough up that the row is dropped from the page: older history
    // loads as the view nears the top, so it takes a few goes.
    await expect
      .poll(async () => {
        await log(page).evaluate((node) => node.scrollTo({ top: 0 }));
        return row(page, id).count();
      })
      .toBe(0);
    // And back to the newest, the way a person would come back.
    const newest = page.getByRole("button", { name: "Back to the newest" });
    await expect
      .poll(async () => {
        if (await newest.isVisible()) await newest.click();
        else await log(page).evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
        return row(page, id).count();
      })
      .toBe(1);
    await expect(row(page, id).getByRole("button", { name: "Show less" })).toBeVisible();
    expect((await drawn(page, id)).lines).toBe(120);
  });

  test("Show all is reachable by keyboard (#304)", async ({ page }) => {
    await open(page);
    const id = await post(page, lines(40));
    const showAll = row(page, id).getByRole("button", { name: "Show all" });
    await showAll.focus();
    await expect(showAll).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row(page, id).getByRole("button", { name: "Show less" })).toBeFocused();
    expect((await drawn(page, id)).lines).toBe(40);
  });
});

test.describe("what a message says", () => {
  test("formatting is drawn as the subset allows, and anything else stays the characters typed (CONV-8)", async ({ page }) => {
    await open(page);
    const id = await post(
      page,
      [
        "**bold** _leaning_ ~~gone~~ `the code` and [the trail](https://millrace-trail.org/river-loop)",
        "",
        "> somebody said this",
        "",
        "- one",
        "- two",
        "",
        "```",
        "let porch = light;",
        "```",
        "",
        "# not a heading",
        "",
        "<b>not markup</b> ![not an image](https://images.example/a.png) \\*not leaning\\*",
      ].join("\n"),
    );
    const text = row(page, id).locator(".nx-text");
    await expect(text.locator("strong")).toHaveText("bold");
    await expect(text.locator("em")).toHaveText("leaning");
    await expect(text.locator("del")).toHaveText("gone");
    await expect(text.locator("code.nx-text-inline-code")).toHaveText("the code");
    await expect(text.getByRole("link", { name: "the trail" })).toHaveAttribute("title", "https://millrace-trail.org/river-loop");
    await expect(text.locator("blockquote")).toHaveText("somebody said this");
    await expect(text.locator("ul li")).toHaveText(["one", "two"]);
    await expect(text.locator("pre code")).toHaveText("let porch = light;");
    // No headings, images or raw HTML: the characters, as typed.
    await expect(text.locator("h1, h2, h3, img, b")).toHaveCount(0);
    await expect(text).toContainText("# not a heading");
    await expect(text).toContainText("<b>not markup</b>");
    await expect(text).toContainText("*not leaning*");
    // A link opens in the browser, never in the window.
    await text.getByRole("link", { name: "the trail" }).click();
    await expect.poll(() => did(page)).toContain("open:https://millrace-trail.org/river-loop");
    expect(page.url()).toContain("/tests/fixtures/next-chat-parity.html");
  });

  test("the lines and indentation someone typed are drawn as typed (#289)", async ({ page }) => {
    await open(page);
    // Typed as the report did: a line, Shift+Enter, the next line, Enter.
    await box(page).click();
    await page.keyboard.type("N I C E");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Nice is how I gotta be");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Nicer than you all for free");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("sent:")).at(-1)).toContain(
      JSON.stringify({ body: "N I C E\nNice is how I gotta be\nNicer than you all for free" }).slice(1, -1),
    );
    const typed = log(page).locator(".nx-text-p", { hasText: "N I C E" });
    await expect(typed).toBeVisible();
    // Drawn, not only kept: what the page shows has the breaks, and the
    // paragraph is three lines tall.
    const drawn = async (paragraph: typeof typed) =>
      paragraph.evaluate((node) => ({
        text: node instanceof HTMLElement ? node.innerText : "",
        lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)),
      }));
    expect(await drawn(typed)).toEqual({ text: "N I C E\nNice is how I gotta be\nNicer than you all for free", lines: 3 });

    // Indentation survives too, and a blank line still starts a new paragraph.
    const id = await post(page, "the steps:\n  first, the ladder\n    then the bulb\n\nand done");
    const paragraphs = row(page, id).locator(".nx-text-p");
    await expect(paragraphs).toHaveCount(2);
    expect(await drawn(paragraphs.first())).toEqual({ text: "the steps:\n  first, the ladder\n    then the bulb", lines: 3 });
    expect(await drawn(paragraphs.last())).toEqual({ text: "and done", lines: 1 });
  });

  test("words are drawn in sans, code alone in mono, and names in the face their owner chose (CONV-5)", async ({ page }) => {
    await open(page);
    const id = await post(page, "the words, then `a bit of code`", "u-jules");
    const faces = await row(page, id).evaluate((node) => {
      const face = (selector: string) => {
        const found = node.querySelector(selector);
        return found ? getComputedStyle(found).fontFamily : "";
      };
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
      return { words: face(".nx-text-p"), code: face(".nx-text-inline-code"), name: face("[data-kit='Name']"), mono };
    });
    // Engines differ on quoting family names (Chromium keeps them, WebKit
    // drops them), so every name is compared without its quotes.
    const unquoted = (families: string) => families.replace(/["']/g, "");
    const monoFace = unquoted(faces.mono.split(",")[0]?.trim() ?? "");
    expect(monoFace).not.toBe("");
    expect(unquoted(faces.words)).not.toContain(monoFace);
    expect(unquoted(faces.code)).toContain(monoFace);
    // Jules chose Instrument Serif.
    expect(unquoted(faces.name)).toContain("Instrument Serif");
    // Nothing else in a message body is mono.
    const monoElsewhere = await log(page).evaluate((node, face) => {
      return [...node.querySelectorAll(".nx-text *, .nx-text")]
        .filter((element) => !element.closest("code, pre"))
        .filter((element) => getComputedStyle(element).fontFamily.replace(/["']/g, "").includes(face))
        .map((element) => element.tagName);
    }, monoFace);
    expect(monoElsewhere).toEqual([]);
  });

  test("a message that names you is marked; naming someone else or nobody isn't (CONV-18)", async ({ page }) => {
    await open(page);
    const mine = await post(page, "hey @matt, the bulb is in the drawer");
    const theirs = await post(page, "@jules you too");
    const nobody = await post(page, "@nobodyhere is a nice name");
    await expect(row(page, mine)).toHaveAttribute("data-names-me", "yes");
    await expect(row(page, mine).locator(".nx-mention")).toHaveAttribute("data-me", "yes");
    await expect(row(page, theirs)).not.toHaveAttribute("data-names-me", "yes");
    await expect(row(page, theirs).locator(".nx-mention")).not.toHaveAttribute("data-me", "yes");
    // A handle nobody answers to is just the characters.
    await expect(row(page, nobody).locator(".nx-mention")).toHaveCount(0);
    await expect(row(page, nobody)).toContainText("@nobodyhere is a nice name");
    // The mark is drawn, not only an attribute: the row differs from its neighbour.
    const looks = await page.evaluate(
      ([one, two]) =>
        [one, two].map((id) => {
          const node = document.querySelector(`[data-message="${id}"]`);
          if (!node) return "";
          const style = getComputedStyle(node);
          return `${style.backgroundColor} ${style.boxShadow} ${style.borderLeftColor} ${style.borderLeftWidth}`;
        }),
      [mine, theirs],
    );
    expect(looks[0]).not.toBe(looks[1]);
  });

  test("reactions the server stores are never drawn or offered (CONV-24)", async ({ page }) => {
    await open(page);
    const id = await post(page, "this deserves a heart", "u-eli", {
      reactions: [{ key: "❤️", user_ids: ["u-jules", "u-dave"], count: 2 }],
    });
    await expect(row(page, id)).not.toContainText("❤️");
    // The count isn't drawn: in the message itself, not the time beside it.
    await expect(row(page, id).locator(".nx-msg-body")).toHaveText("this deserves a heart");
    await row(page, id).hover();
    await row(page, id).getByRole("button", { name: /^Actions for/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    const offered = await page.getByRole("menuitem").allTextContents();
    expect(offered.map((label) => label.trim())).toEqual(["Reply", "Pin", "Delete"]);
    expect(offered.join(" ")).not.toMatch(/react/i);
  });

  test("hovering a message shows its button and moves nothing (CONV-21)", async ({ page }) => {
    await open(page);
    const boxes = () =>
      log(page).evaluate((node) =>
        [...node.querySelectorAll("[data-message]")].map((message) => {
          const rect = message.getBoundingClientRect();
          const inner = [...message.querySelectorAll("*")].map((child) => {
            const box = child.getBoundingClientRect();
            return `${Math.round(box.x * 10)},${Math.round(box.y * 10)},${Math.round(box.width * 10)},${Math.round(box.height * 10)}`;
          });
          return `${message.getAttribute("data-message")} ${rect.x} ${rect.y} ${rect.width} ${rect.height} ${inner.join(" ")}`;
        }),
      );
    const target = row(page, "m000014");
    const button = target.locator(".nx-msg-actions");
    await page.mouse.move(5, 5);
    await expect(button).toHaveCSS("opacity", "0");
    // Wait for the conversation to settle: the trail's card arrives on its
    // own, and then the bare address gives way to the card alone.
    await expect(row(page, "m000013").locator(".nx-linkcard")).toBeVisible();
    await expect(row(page, "m000013").locator(".nx-text")).toHaveCount(0);
    const before = await boxes();
    await target.hover();
    await expect(button).toHaveCSS("opacity", "1");
    expect(await boxes()).toEqual(before);
  });
});

test.describe("changing a message", () => {
  const MINE = "m000014";

  async function startEditing(page: Page) {
    await row(page, MINE).hover();
    await row(page, MINE).getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = row(page, MINE).getByRole("textbox", { name: "Edit this message" });
    await expect(edit).toBeFocused();
    return edit;
  }

  test("an edit starts with the cursor at the end, and Escape gives it up, saving nothing (CONV-23)", async ({ page }) => {
    await open(page);
    const edit = await startEditing(page);
    const length = (await edit.inputValue()).length;
    expect(await edit.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([length, length]);
    await edit.pressSequentially(" Maybe 10?");
    await edit.press("Escape");
    await expect(row(page, MINE).getByRole("textbox", { name: "Edit this message" })).toHaveCount(0);
    await expect(row(page, MINE)).toContainText("Count me in. Let's put the details in #weekend-plans when we know.");
    await expect(row(page, MINE)).not.toContainText("Maybe 10?");
    expect((await did(page)).filter((line) => line.startsWith("PATCH"))).toEqual([]);
  });

  test("a refused edit says why on the spot and keeps the words (CONV-23)", async ({ page }) => {
    await open(page, "room=r-general&refuse");
    const edit = await startEditing(page);
    await edit.pressSequentially(" Maybe 10?");
    await edit.press("Enter");
    await expect(row(page, MINE)).toContainText("The host has locked this room's history.");
    await expect(edit).toHaveValue("Count me in. Let's put the details in #weekend-plans when we know. Maybe 10?");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("PATCH /messages/m000014"))).toHaveLength(1);
  });

  test("a refused delete is said on that message, and the message stays (CONV-22)", async ({ page }) => {
    await open(page, "room=r-general&refuse");
    await row(page, MINE).hover();
    await row(page, MINE).getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Delete for good" }).click();
    await expect(row(page, MINE).getByRole("alert")).toHaveText("The host has locked this room's history.");
    await expect(row(page, MINE)).toContainText("Count me in.");
    // Said on that message only.
    await expect(log(page).getByRole("alert")).toHaveCount(1);
  });
});

test.describe("the message box", () => {
  test("holds 8,000 characters and says so near the ceiling, before anything goes to the server (COMP-8)", async ({ page }) => {
    await open(page);
    await box(page).fill("a".repeat(7_900));
    await expect(page.getByText("100 characters left")).toBeVisible();
    await box(page).fill("b".repeat(8_050));
    await expect(box(page)).toHaveValue("b".repeat(8_000));
    await expect(page.getByText("0 characters left")).toBeVisible();
    await box(page).fill("short again");
    await expect(page.getByText(/characters left/)).toHaveCount(0);
  });

  test("takes ten files for a message and says so about the eleventh (COMP-8)", async ({ page }) => {
    await open(page);
    const files = Array.from({ length: 11 }, (_, index) => ({ name: `note-${index + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`note ${index + 1}`) }));
    await page.locator(".nx-composer input[type='file']").setInputFiles(files);
    const listed = page.getByRole("list", { name: "Files for this message" }).getByRole("listitem");
    await expect(listed).toHaveCount(10);
    await expect(page.locator(".nx-composer").getByRole("alert")).toHaveText("One message carries at most 10 files.");
    // The eleventh never went up.
    await expect.poll(async () => (await did(page)).filter((line) => line === "POST /uploads as token-1")).toHaveLength(10);
  });

  test("a file dropped on the box or pasted into it is shared, and the drop never leaves the page (COMP-11)", async ({ page }) => {
    await open(page);
    const dropped = await page.locator(".nx-composer").evaluate((form) => {
      const data = new DataTransfer();
      data.items.add(new File(["porch"], "porch.txt", { type: "text/plain" }));
      const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
      const drop = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
      // Both cancelled: a drop the page doesn't cancel is a drop the webview follows.
      return { over: !form.dispatchEvent(over), drop: !form.dispatchEvent(drop) };
    });
    expect(dropped).toEqual({ over: true, drop: true });
    const listed = page.getByRole("list", { name: "Files for this message" });
    await expect(listed).toContainText("porch.txt");

    const pasted = await box(page).evaluate((field) => {
      const data = new DataTransfer();
      data.items.add(new File(["light"], "light.txt", { type: "text/plain" }));
      const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      return !field.dispatchEvent(paste);
    });
    expect(pasted).toBe(true);
    await expect(listed).toContainText("light.txt");
    await expect(box(page)).toHaveValue("");
    expect(page.url()).toContain("/tests/fixtures/next-chat-parity.html");
  });
});

/** Justin B, whose username is nothing like his name (#267), arriving on the server as a frame. */
const JUSTIN = {
  id: "u-justin",
  username: "bendthebracket",
  display_name: "Justin B",
  is_host: false,
  style: { font_key: "inter", weight: 700, italic: false, fill: { kind: "solid", color: "sky" }, effect: "none", msg_font_key: null },
  status: null,
  entrance_sound: null,
  last_seen_at: null,
};

async function arrives(page: Page, user: Record<string, unknown> = JUSTIN) {
  await page.evaluate((person) => window.parity?.frame({ op: "user.update", d: person } as never), user);
}

const people = (page: Page) => page.getByRole("listbox", { name: "People to mention" });
const offered = (page: Page) => people(page).getByRole("option");
const sent = async (page: Page) => (await did(page)).filter((line) => line.startsWith("sent:"));

test.describe("mentioning somebody by the name you know (#267)", () => {
  test("@ju lists Justin B, and Enter puts in @bendthebracket and a space without sending", async ({ page }) => {
    await open(page);
    await arrives(page);
    await box(page).click();
    await box(page).pressSequentially("hey @ju");
    // Jules is in #general, so she comes first; Justin isn't, so he follows.
    await expect(offered(page)).toHaveText([/^Jules\s*@jules$/, /^Justin B\s*@bendthebracket$/]);
    await expect(offered(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(offered(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(box(page)).toHaveValue("hey @bendthebracket ");
    await expect(people(page)).toHaveCount(0);
    await expect(box(page)).toBeFocused();
    expect(await sent(page)).toEqual([]);
    // The caret is after the space: what's typed next follows it.
    await page.keyboard.type("look");
    await expect(box(page)).toHaveValue("hey @bendthebracket look");
    // With the list closed, Enter sends as ever, and what's stored is the username.
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sent(page)).join()).toContain('"body":"hey @bendthebracket look"');
  });

  test("Escape closes the list and keeps what was typed; Enter with the list open never sends", async ({ page }) => {
    await open(page);
    await box(page).click();
    await box(page).pressSequentially("@ca");
    await expect(offered(page)).toHaveText([/^Callie/]);
    await page.keyboard.press("Control+Enter");
    await expect(box(page)).toHaveValue("@callie ");
    expect(await sent(page)).toEqual([]);

    await box(page).fill("");
    await box(page).pressSequentially("ask @ca");
    await expect(people(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(people(page)).toHaveCount(0);
    await expect(box(page)).toHaveValue("ask @ca");
    await expect(box(page)).toHaveAttribute("aria-expanded", "false");
    // It stays closed on that @, however much more is typed.
    await page.keyboard.type("l");
    await expect(people(page)).toHaveCount(0);
    // A new @ opens it again.
    await page.keyboard.type(" and @d");
    await expect(offered(page)).toHaveText([/^Dave/]);
  });

  test("a click on somebody puts them in, and the box keeps the keyboard", async ({ page }) => {
    await open(page);
    await arrives(page);
    await box(page).click();
    await box(page).pressSequentially("@bend");
    await offered(page).filter({ hasText: "Justin B" }).click();
    await expect(box(page)).toHaveValue("@bendthebracket ");
    await expect(box(page)).toBeFocused();
    await expect(people(page)).toHaveCount(0);
  });

  test("an address opens nothing, nor does code", async ({ page }) => {
    await open(page);
    await box(page).click();
    await box(page).pressSequentially("write to you@example.com");
    await expect(people(page)).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("aria-expanded", "false");
    // Inside a code span it's the characters typed, never a mention.
    await box(page).fill("");
    await box(page).pressSequentially("`@ju`");
    await page.keyboard.press("ArrowLeft");
    await expect(people(page)).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("a DM lists only its people, never you", async ({ page }) => {
    await open(page, "room=d-eli-sam");
    await arrives(page);
    await box(page).click();
    await box(page).pressSequentially("@");
    await expect(offered(page)).toHaveText([/^Eli/, /^Sam/]);
  });

  test("the list is the box's listbox: named, reached by the keys, the highlighted one announced", async ({ page }) => {
    await open(page);
    await box(page).click();
    await expect(box(page)).toHaveAttribute("aria-expanded", "false");
    await box(page).pressSequentially("@");
    await expect(box(page)).toHaveAttribute("aria-expanded", "true");
    await expect(box(page)).toHaveAttribute("aria-autocomplete", "list");
    const list = people(page);
    await expect(list).toBeVisible();
    await expect(box(page)).toHaveAttribute("aria-controls", (await list.getAttribute("id")) ?? "none");
    // Everyone on the server but you: #general's people first, then the rest, by name.
    await expect(offered(page)).toHaveText([/^Eli/, /^Jules/, /^Callie/, /^Dave/, /^Jen/, /^Sam/]);
    const highlighted = async () => {
      const id = await box(page).getAttribute("aria-activedescendant");
      return id === null ? null : page.evaluate((one) => document.getElementById(one)?.getAttribute("aria-label") ?? null, id);
    };
    expect(await highlighted()).toBe("Eli, @eli");
    await page.keyboard.press("ArrowUp");
    expect(await highlighted()).toBe("Sam, @sam");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted()).toBe("Jules, @jules");
    await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("aria-label", "Jules, @jules");
    // Tab takes the highlighted one too.
    await page.keyboard.press("Tab");
    await expect(box(page)).toHaveValue("@jules ");
    await expect(box(page)).toBeFocused();
    // The list floats above the box, inside the window, in the kit's rows.
    await page.keyboard.type("@");
    const [floating, field] = [await list.boundingBox(), await page.locator(".nx-composer-box").boundingBox()];
    expect(floating && field && floating.y + floating.height <= field.y && floating.y >= 0).toBe(true);
    const heights = await offered(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([32]));
  });

  test("an input method composing neither opens the list nor moves it", async ({ page }) => {
    await open(page);
    await box(page).click();
    await box(page).dispatchEvent("compositionstart", { data: "" });
    await page.keyboard.insertText("@ju");
    await expect(people(page)).toHaveCount(0);
    await box(page).dispatchEvent("compositionend", { data: "@ju" });
    await expect(people(page)).toBeVisible();
    await expect(offered(page).first()).toHaveAttribute("aria-selected", "true");
    // Keys the input method is still using belong to it: nothing moves, nothing is chosen or sent.
    await box(page).dispatchEvent("compositionstart", { data: "" });
    await box(page).evaluate((field) => {
      for (const key of ["ArrowDown", "Enter", "Tab"]) field.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true }));
    });
    await expect(offered(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(box(page)).toHaveValue("@ju");
    expect(await sent(page)).toEqual([]);
  });

  test("a mention reads as the name people know, the username in its tooltip, looked up live", async ({ page }) => {
    await open(page);
    await arrives(page);
    const id = await post(page, "ask @bendthebracket about the bulb");
    const mention = row(page, id).locator(".nx-mention");
    await expect(mention).toHaveText("@Justin B");
    await expect(mention).toHaveAttribute("title", "@bendthebracket");
    // In the mention's own highlight, not his name's face or color.
    const looks = await mention.evaluate((node) => {
      const words = getComputedStyle(node.closest(".nx-text") ?? node);
      const own = getComputedStyle(node);
      return { same: own.fontFamily === words.fontFamily, color: own.color };
    });
    expect(looks.same).toBe(true);
    // A changed name shows in old messages too.
    await arrives(page, { ...JUSTIN, display_name: "Justin Bend" });
    await expect(mention).toHaveText("@Justin Bend");
    // A handle nobody has stays as typed.
    const nobody = await post(page, "@nobodyhere hi");
    await expect(row(page, nobody)).toContainText("@nobodyhere hi");
    await expect(row(page, nobody).locator(".nx-mention")).toHaveCount(0);
    // A mention of you keeps its stronger mark.
    const mine = await post(page, "@matt the porch light");
    await expect(row(page, mine).locator(".nx-mention")).toHaveText("@Matt");
    await expect(row(page, mine).locator(".nx-mention")).toHaveAttribute("data-me", "yes");
    await expect(row(page, mine)).toHaveAttribute("data-names-me", "yes");
  });
});

test.describe("files", () => {
  test("a file goes up as slot, bytes and complete, shows it's going up, and the message carries it (FILE-1)", async ({ page }) => {
    await open(page, "room=r-general&holdparts");
    await page.locator(".nx-composer input[type='file']").setInputFiles({ name: "porch-plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF plan") });
    const going = page.getByRole("progressbar", { name: "Uploading porch-plan.pdf" });
    await expect(going).toBeVisible();
    // Still going up: Send waits, and the draft is kept.
    await box(page).fill("the plan");
    await box(page).press("Enter");
    await expect(page.locator(".nx-composer").getByRole("alert")).toHaveText("The file is still uploading. Your draft is kept here.");
    await expect(box(page)).toHaveValue("the plan");

    await page.evaluate(() => window.parity?.release());
    await expect(going).toHaveCount(0);
    const asked = await did(page);
    const slot = asked.indexOf("POST /uploads as token-1");
    const bytes = asked.indexOf("PUT /store/f-1/1");
    const complete = asked.indexOf("POST /uploads/f-1/complete as token-1");
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(bytes).toBeGreaterThan(slot);
    expect(complete).toBeGreaterThan(bytes);

    await box(page).press("Enter");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("sent:")).at(-1)).toBe(
      `sent:${JSON.stringify({ body: "the plan", reply_to: null, attachment_ids: ["f-1"] })}`,
    );
    await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
    await expect(log(page).locator(".nx-att-name", { hasText: "porch-plan.pdf" })).toBeVisible();
  });

  test("a part the file store drops is sent again, and the file still goes up whole (FILE-1)", async ({ page }) => {
    await open(page, "room=r-general&flakystore");
    await page.locator(".nx-composer input[type='file']").setInputFiles({ name: "porch-plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF plan") });
    await expect.poll(async () => (await did(page)).includes("POST /uploads/f-1/complete as token-1")).toBe(true);
    expect((await did(page)).filter((line) => line === "PUT /store/f-1/1")).toHaveLength(2);
    const file = page.getByRole("list", { name: "Files for this message" }).getByRole("listitem");
    await expect(file.getByRole("progressbar")).toHaveCount(0);
    await expect(file).not.toContainText(/didn't|refused|couldn't/i);
  });

  test("a file the server won't take says so on that file, and the rest of the box is untouched (FILE-1)", async ({ page }) => {
    await open(page, "room=r-general&uploadrefuse");
    await box(page).fill("keep me");
    await page.locator(".nx-composer input[type='file']").setInputFiles({ name: "huge.mov", mimeType: "video/quicktime", buffer: Buffer.from("big") });
    const file = page.getByRole("list", { name: "Files for this message" }).getByRole("listitem");
    await expect(file).toContainText("That file is bigger than this server takes.");
    await expect(box(page)).toHaveValue("keep me");
  });

  test("a file can be taken out before sending, and one already up is withdrawn from the server (FILE-2)", async ({ page }) => {
    await open(page);
    await page.locator(".nx-composer input[type='file']").setInputFiles({ name: "wrong-photo.txt", mimeType: "text/plain", buffer: Buffer.from("oops") });
    const listed = page.getByRole("list", { name: "Files for this message" });
    await expect.poll(async () => (await did(page)).includes("POST /uploads/f-1/complete as token-1")).toBe(true);
    await expect(listed.getByRole("progressbar")).toHaveCount(0);
    await page.getByRole("button", { name: "Don't send wrong-photo.txt" }).click();
    await expect(listed).toHaveCount(0);
    await expect.poll(async () => did(page)).toContain("DELETE /uploads/f-1 as token-1");
    // Nothing of it goes with the next message.
    await box(page).fill("just words");
    await box(page).press("Enter");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("sent:")).at(-1)).toBe(
      `sent:${JSON.stringify({ body: "just words", reply_to: null, attachment_ids: null })}`,
    );
  });
});

test.describe("a send nobody answers", () => {
  test("gives up after its deadline and says it wasn't confirmed, not that it was lost (COMP-4)", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-25T22:52:00") });
    await open(page, "room=r-general&hang");
    await page.clock.pauseAt(new Date("2026-09-25T22:53:00"));
    await box(page).fill("did this land?");
    await box(page).press("Enter");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("sent:"))).toHaveLength(1);
    // Still waiting, just short of the deadline: nothing said yet.
    await page.clock.runFor(29_000);
    await expect(page.locator(".nx-composer").getByRole("alert")).toHaveCount(0);
    await page.clock.runFor(2_000);
    await expect(page.locator(".nx-composer").getByRole("alert")).toHaveText(
      "The server did not confirm the request. Check whether it arrived before trying again.",
    );
    // The words are kept, to send again once you've looked.
    await expect(box(page)).toHaveValue("did this land?");
  });
});

test("a send that can't reach the server says so in the chat's words, and keeps the message", async ({ page }) => {
  await open(page, "room=r-general&offline");
  await box(page).fill("anyone there?");
  await box(page).press("Enter");
  // Not the sign-in's "check the address", and not "not confirmed": it never left.
  await expect(page.locator(".nx-composer").getByRole("alert")).toHaveText("Couldn't reach the server. Your message is kept here.");
  await expect(box(page)).toHaveValue("anyone there?");
});

test.describe("files in the conversation", () => {
  function attachment(id: string, filename: string, mime: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      filename,
      mime,
      size_bytes: 48_000,
      url: `/media/${id}`,
      width: null,
      height: null,
      duration_ms: null,
      blurhash: null,
      poster_url: null,
      starred_at: null,
      uploader_id: "u-eli",
      created_at: Date.parse("2026-09-25T22:50:00"),
      ...extra,
    };
  }

  test("a picture has its true shape before its bytes arrive, a tall one is capped at 400, and neither moves its row (FILE-3)", async ({ page }) => {
    await open(page);
    // The pictures' bytes wait until the test lets them go. (Routed after
    // opening: the newest route that matches is the one that answers.)
    let letGo: () => void = () => undefined;
    const waiting = new Promise<void>((settle) => {
      letGo = settle;
    });
    await page.route(`${SERVER}/media/pic-*`, async (route) => {
      await waiting;
      const tall = route.request().url().endsWith("pic-tall");
      const [w, h] = tall ? [600, 2400] : [320, 180];
      await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#445"/></svg>` });
    });
    const id = await post(page, "two pictures", "u-eli", {
      attachments: [attachment("pic-wide", "wide.svg", "image/svg+xml", { width: 320, height: 180 }), attachment("pic-tall", "tall.svg", "image/svg+xml", { width: 600, height: 2400 })],
    });
    const pictures = row(page, id).locator(".nx-att-image img");
    await expect(pictures).toHaveCount(2);
    await expect(pictures.first()).toHaveAttribute("loading", "lazy");
    const sizes = () =>
      pictures.evaluateAll((images) =>
        images.map((image) => {
          const box = image.getBoundingClientRect();
          return [Math.round(box.width), Math.round(box.height)];
        }),
      );
    const rowHeight = () => row(page, id).evaluate((node) => node.getBoundingClientRect().height);
    // Nothing has arrived yet.
    expect(await pictures.evaluateAll((images) => images.map((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toEqual([false, false]);
    const before = await sizes();
    const [wideW = 0, wideH = 0] = before[0] ?? [];
    const [tallW = 0, tallH = 0] = before[1] ?? [];
    // True shape, inside the frame's caps (320 wide with its border, 400 tall).
    expect(wideW).toBeGreaterThan(300);
    expect(wideW).toBeLessThanOrEqual(320);
    expect(Math.abs(wideW / wideH - 320 / 180)).toBeLessThan(0.03);
    expect(tallH).toBe(400);
    expect(Math.abs(tallW / tallH - 600 / 2400)).toBeLessThan(0.01);
    const heightBefore = await rowHeight();

    letGo();
    await expect.poll(() => pictures.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await sizes()).toEqual(before);
    expect(await rowHeight()).toBe(heightBefore);
  });

  test("video gets its poster and its player, audio Linger's player, anything else one line and a download button (FILE-5)", async ({ page }) => {
    await open(page);
    const id = await post(page, "three files", "u-eli", {
      attachments: [
        attachment("vid-1", "porch-timelapse.mp4", "video/mp4", { width: 640, height: 360, poster_url: "/media/vid-1-poster" }),
        attachment("aud-1", "rain-sounds.mp3", "audio/mpeg", { duration_ms: 3_725_000 }),
        attachment("doc-1", "wiring.pdf", "application/pdf"),
      ],
    });
    const video = row(page, id).locator("video");
    await expect(video).toHaveAttribute("poster", `${SERVER}/media/vid-1-poster`);
    await expect(video).toHaveAttribute("src", `${SERVER}/media/vid-1`);
    await expect(video).toHaveJSProperty("controls", true);
    await expect(video).toHaveAccessibleName("porch-timelapse.mp4");

    // Audio has no engine controls: Linger draws its own (#247, below), with
    // the length the server measured until the file says its own.
    const sound = row(page, id).getByRole("group", { name: "rain-sounds.mp3" });
    await expect(sound.locator("audio")).toHaveJSProperty("controls", false);
    await expect(sound.locator("audio")).toHaveAttribute("src", `${SERVER}/media/aud-1`);
    await expect(sound.locator(".nx-audio-time > span").first()).toHaveText("0:00 / 1:02:05");

    // Anything else is never shown in the app: one line, and a way to download it
    // (what the download does is FILE-6's).
    const other = row(page, id).locator(".nx-att-card").filter({ hasText: "wiring.pdf" });
    await expect(other.locator("iframe, embed, object, img, video, audio")).toHaveCount(0);
    await expect(other.getByRole("button", { name: /Download/ })).toBeVisible();
  });

  // The picture viewer (FILE-4): over the whole window, fitted without
  // cropping or blowing a small picture up, centered with its name, refitted
  // when the window changes size, and closed by Escape, a click or its button
  // with focus handed back.
  const PICTURES = [
    { id: "fit-portrait", filename: "portrait.png", width: 1200, height: 2400 },
    { id: "fit-landscape", filename: "landscape.png", width: 2400, height: 600 },
    { id: "fit-small", filename: "small.png", width: 96, height: 64 },
    { id: "fit-long", filename: `${"long-filename-".repeat(16)}.png`, width: 1200, height: 900 },
  ];

  async function showPictures(page: Page) {
    await open(page);
    await page.route(`${SERVER}/media/fit-*`, (route) => {
      const found = PICTURES.find((picture) => route.request().url().endsWith(picture.id));
      const [w, h] = found ? [found.width, found.height] : [8, 5];
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#445"/></svg>` });
    });
    for (const picture of PICTURES) {
      await post(page, `look at ${picture.id}`, "u-eli", {
        attachments: [attachment(picture.id, picture.filename, "image/png", { width: picture.width, height: picture.height })],
      });
    }
  }

  /** Where the picture is drawn inside its box (object-fit: contain), its name, and the viewer. */
  const viewerGeometry = (page: Page) =>
    page.getByRole("dialog").evaluate((dialog) => {
      const image = dialog.querySelector("img");
      const name = dialog.querySelector(".nx-viewer-name");
      if (!(image instanceof HTMLImageElement) || !name) throw new Error("no picture or name in the viewer");
      const box = image.getBoundingClientRect();
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const drawn = { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
      const picture = { x: box.x + (box.width - drawn.width) / 2, y: box.y + (box.height - drawn.height) / 2, ...drawn };
      const label = name.getBoundingClientRect();
      const overlay = dialog.getBoundingClientRect();
      const style = getComputedStyle(dialog);
      const top = overlay.y + parseFloat(style.paddingTop);
      const bottom = overlay.bottom - parseFloat(style.paddingBottom);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overlay: { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height },
        picture,
        scale,
        name: { x: label.x, right: label.right, bottom: label.bottom },
        middle: (top + bottom) / 2,
        groupMiddle: (box.y + label.bottom) / 2,
      };
    });

  async function expectFitted(page: Page) {
    const at = await viewerGeometry(page);
    expect(at.overlay).toEqual({ x: 0, y: 0, ...at.viewport });
    expect(at.picture.x).toBeGreaterThanOrEqual(-0.5);
    expect(at.picture.y).toBeGreaterThanOrEqual(-0.5);
    expect(at.picture.x + at.picture.width).toBeLessThanOrEqual(at.viewport.width + 0.5);
    expect(at.picture.y + at.picture.height).toBeLessThanOrEqual(at.viewport.height + 0.5);
    expect(at.name.x).toBeGreaterThanOrEqual(0);
    expect(at.name.right).toBeLessThanOrEqual(at.viewport.width);
    expect(at.name.bottom).toBeLessThanOrEqual(at.viewport.height);
    // Never enlarged past its own size.
    expect(at.scale).toBeLessThanOrEqual(1.001);
    // Centered across the window, and the picture and its name together
    // centered down it.
    expect(Math.abs(at.picture.x + at.picture.width / 2 - at.viewport.width / 2)).toBeLessThan(1);
    expect(Math.abs(at.groupMiddle - at.middle)).toBeLessThan(1);
    return at;
  }

  for (const picture of PICTURES) {
    test(`the viewer fits ${picture.filename.slice(0, 24)} in the window, and again when it changes size (FILE-4)`, async ({ page }) => {
      await showPictures(page);
      await page.getByRole("button", { name: `Open ${picture.filename}` }).click();
      const expanded = page.getByRole("dialog").locator("img");
      await expect(expanded).toBeVisible();
      await expect.poll(() => expanded.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
      const first = await expectFitted(page);
      if (picture.id === "fit-small") expect(first.scale).toBeCloseTo(1, 3);
      await page.setViewportSize({ width: 760, height: 480 });
      await expectFitted(page);
      await page.setViewportSize({ width: 480, height: 320 });
      await expectFitted(page);
    });
  }

  test("the viewer closes by Escape, a click on the picture, the backdrop or its button, keeps Tab inside, and hands focus back (FILE-4)", async ({ page }) => {
    await showPictures(page);
    const opener = page.getByRole("button", { name: "Open small.png" });
    const viewer = page.getByRole("dialog", { name: "small.png" });
    const close = viewer.getByRole("button", { name: "Close the picture" });
    await opener.focus();
    await opener.press("Enter");
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.press("Enter");
    await viewer.locator("img").click();
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.press("Enter");
    await viewer.click({ position: { x: 2, y: 2 } });
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.press("Enter");
    await close.click();
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

/** A real four-second WebM (VP8, 160×90, its index at the front), for playing and seeking. */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
/** The largest piece the fake server sends at once, so the player has to come back for the rest. */
const PIECE = 8 * 1024;

/**
 * A file store for `/media/<prefix>*`, answering as the server does since
 * #222: one byte range at a time, with `206` and `Content-Range`. It sends at
 * most `PIECE` bytes per answer, which a server may, so reaching the end of
 * the file takes a range that starts partway in, the request a seek makes.
 * A range that starts at or past the end is `416`, its `Content-Range`
 * giving only the file's length, as the server answers it
 * (routes/objects.rs). This used to answer an impossible `206` instead,
 * which hid that WebKit takes that `416` as a failed load (#336, #343).
 * While `down`, every request fails.
 */
async function byteStore(page: Page, prefix: string, bytes: Buffer, contentType: string) {
  const store = { down: false, ranges: [] as string[] };
  await page.route(`${SERVER}/media/${prefix}*`, async (route) => {
    if (store.down) return route.fulfill({ status: 503 });
    const range = route.request().headers()["range"];
    const asked = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    if (!range || !asked) return route.fulfill({ status: 200, contentType, headers: { "accept-ranges": "bytes" }, body: bytes });
    store.ranges.push(range);
    const start = Number(asked[1]);
    if (start >= bytes.length)
      return route.fulfill({ status: 416, headers: { "accept-ranges": "bytes", "content-range": `bytes */${bytes.length}`, "cache-control": "no-store" } });
    const end = Math.min(bytes.length - 1, start + PIECE - 1, asked[2] ? Number(asked[2]) : Number.POSITIVE_INFINITY);
    await route.fulfill({
      status: 206,
      contentType,
      headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
      body: bytes.subarray(start, end + 1),
    });
  });
  return store;
}

/** The store for `/media/vid-*`, holding the clip. */
function videoStore(page: Page) {
  return byteStore(page, "vid-", CLIP, "video/webm");
}

test.describe("a shared video (#222)", () => {
  const clip = {
    id: "vid-clip",
    filename: "porch-light.webm",
    mime: "video/webm",
    size_bytes: CLIP.length,
    url: "/media/vid-clip",
    width: 320,
    height: 180,
    duration_ms: 4_000,
    blurhash: null,
    poster_url: null,
    starred_at: null,
    uploader_id: "u-eli",
    created_at: Date.parse("2026-09-25T22:50:00"),
  };
  const player = (page: Page, id: string) => row(page, id).locator("video");
  const time = (page: Page, id: string) => player(page, id).evaluate((video: HTMLVideoElement) => video.currentTime);
  const ready = (page: Page, id: string) => player(page, id).evaluate((video: HTMLVideoElement) => video.readyState);

  /** The chat window with the video store in front of it, on an engine that can play the clip. */
  async function openWithVideo(page: Page) {
    await open(page);
    const playable = await page.evaluate(() => document.createElement("video").canPlayType('video/webm; codecs="vp8"'));
    test.skip(playable === "", "this engine can't play WebM");
    return videoStore(page);
  }

  test("seeks by asking for the part it needs, and plays on from there", async ({ page }) => {
    const store = await openWithVideo(page);
    const id = await post(page, "the porch light at dusk", "u-eli", { attachments: [clip] });
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);

    await player(page, id).evaluate(
      (video: HTMLVideoElement) =>
        new Promise<void>((settle) => {
          video.addEventListener("seeked", () => settle(), { once: true });
          video.currentTime = 3.5;
        }),
    );
    expect(await time(page, id)).toBeCloseTo(3.5, 1);
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(2);
    expect(await player(page, id).evaluate((video: HTMLVideoElement) => video.error)).toBeNull();
    await expect(row(page, id).getByRole("alert")).toHaveCount(0);
    // It came back for a later part of the file, and got it.
    expect(store.ranges.some((range) => !range.startsWith("bytes=0-"))).toBe(true);
  });

  test("one that can't load says so over its own frame, and loads again in place", async ({ page }) => {
    const store = await openWithVideo(page);
    store.down = true;
    const id = await post(page, "the porch light at dusk", "u-eli", { attachments: [clip] });
    const frame = await player(page, id).boundingBox();
    const rowHeight = await row(page, id).evaluate((node) => node.getBoundingClientRect().height);

    const note = row(page, id).getByRole("alert");
    await expect(note).toHaveText("Couldn't load this video.");
    const again = row(page, id).getByRole("button", { name: "Load again" });
    await expect(again).toBeVisible();
    // Over the player's own frame, exactly: nothing below it moves.
    expect(await row(page, id).locator(".nx-att-video-failed").boundingBox()).toEqual(frame);
    expect(await row(page, id).evaluate((node) => node.getBoundingClientRect().height)).toBe(rowHeight);

    store.down = false;
    await again.click();
    await expect(note).toHaveCount(0);
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);
    expect(await player(page, id).evaluate((video: HTMLVideoElement) => video.duration)).toBeCloseTo(4, 0);
    // The button went; the keyboard is on the player it brought back.
    await expect(player(page, id)).toBeFocused();
  });

  test("loading again picks up where it had got to", async ({ page }) => {
    await openWithVideo(page);
    const id = await post(page, "the porch light at dusk", "u-eli", { attachments: [clip] });
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);
    await player(page, id).evaluate(
      (video: HTMLVideoElement) =>
        new Promise<void>((settle) => {
          video.addEventListener("seeked", () => settle(), { once: true });
          video.currentTime = 2.5;
        }),
    );
    // A player giving up partway can't be staged by the network here: once its
    // bytes are in, it asks for nothing more. So it gives up by its own event.
    await player(page, id).evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event("error")));
    await row(page, id).getByRole("button", { name: "Load again" }).click();
    await expect(row(page, id).getByRole("alert")).toHaveCount(0);
    await expect.poll(() => time(page, id)).toBeCloseTo(2.5, 1);
  });
});

/**
 * Four seconds of a quiet 16-bit, 8 kHz mono WAV (64 KB), made here: every
 * engine plays it without a codec to install, and it takes eight of the
 * store's pieces, so seeking into it asks for a range partway in.
 */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  // A faint hum rather than silence, so nothing takes it for an empty file.
  for (let at = 0; at < samples; at += 1) data.writeInt16LE(Math.round(Math.sin((at / rate) * 2 * Math.PI * 220) * 600), at * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const RAIN = wav(4);

test.describe("a shared audio file (#247)", () => {
  const rain = {
    id: "aud-rain",
    filename: "porch-rain.wav",
    mime: "audio/wav",
    size_bytes: RAIN.length,
    url: "/media/aud-rain",
    width: null,
    height: null,
    duration_ms: 4_000,
    blurhash: null,
    poster_url: null,
    starred_at: null,
    uploader_id: "u-eli",
    created_at: Date.parse("2026-09-25T22:50:00"),
  };
  const card = (page: Page, id: string) => row(page, id).getByRole("group", { name: "porch-rain.wav" });
  const sound = (page: Page, id: string) => card(page, id).locator("audio");
  const shown = (page: Page, id: string) => card(page, id).locator(".nx-audio-time > span").first();
  const ready = (page: Page, id: string) => sound(page, id).evaluate((audio: HTMLAudioElement) => audio.readyState);
  const read = <T,>(page: Page, id: string, what: (audio: HTMLAudioElement) => T) => sound(page, id).evaluate(what);

  /** The chat window with the audio store in front of it, on an engine that can play a WAV. */
  async function openWithAudio(page: Page) {
    await open(page);
    const playable = await page.evaluate(() => document.createElement("audio").canPlayType("audio/wav"));
    test.skip(playable === "", "this engine can't play WAV");
    return byteStore(page, "aud-", RAIN, "audio/wav");
  }

  test("is Linger's own player, every part named, on the card's two lines", async ({ page }) => {
    await openWithAudio(page);
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const player = card(page, id);
    await expect(player).toBeVisible();
    // None of the engine's own controls, whichever engine this is.
    await expect(sound(page, id)).toHaveJSProperty("controls", false);
    await expect(sound(page, id)).toBeHidden();
    await expect(player.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(player.getByRole("slider", { name: "Timeline" })).toHaveAttribute("aria-valuetext", "0:00 of 0:04");
    await expect(shown(page, id)).toHaveText("0:00 / 0:04");
    await expect(player.getByRole("button", { name: "Mute" })).toBeVisible();
    await expect(player.getByRole("slider", { name: "Volume" })).toHaveAttribute("aria-valuetext", "100%");
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);

    const geometry = await player.evaluate((node) => {
      const box = (element: Element | null) => {
        if (!element) throw new Error("missing part");
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const style = getComputedStyle(node);
      return {
        card: box(node),
        padding: { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) },
        border: Number.parseFloat(style.borderLeftWidth),
        icon: box(node.querySelector('[data-kit="Icon"]')),
        time: box(node.querySelector(".nx-audio-time")),
        line: box(node.querySelector(".nx-audio-controls")),
        controls: [...node.querySelectorAll("[data-kit-control]")].map((control) => ({ kit: (control as HTMLElement).dataset.kit, ...box(control) })),
      };
    });
    // The controls' line is one control tall, as the engine's player was.
    expect(geometry.line.height).toBe(32);
    // Every control is a kit size, centered on that line.
    expect(geometry.controls.map((control) => [control.kit, control.height])).toEqual([
      ["IconButton", 32],
      ["Slider", 24],
      ["IconButton", 32],
      ["Slider", 24],
    ]);
    for (const control of geometry.controls) expect(Math.abs(control.top + control.height / 2 - (geometry.line.top + geometry.line.height / 2))).toBeLessThanOrEqual(0.5);
    // Inside the card's padding: the controls start on the icon's edge and end on the time's.
    const inner = { left: geometry.card.left + geometry.border + geometry.padding.left, right: geometry.card.right - geometry.border - geometry.padding.right };
    expect(geometry.controls[0]?.left).toBeCloseTo(inner.left, 0);
    expect(geometry.icon.left).toBeCloseTo(inner.left, 0);
    expect(geometry.controls.at(-1)?.right).toBeCloseTo(inner.right, 0);
    expect(geometry.time.right).toBeCloseTo(inner.right, 0);
    // The card is a picture's width, and the timeline has room in it.
    expect(geometry.card.width).toBe(320);
    expect(geometry.controls[1]?.width).toBeGreaterThan(120);
  });

  test("plays and pauses from its own button, which says which it will do", async ({ page }) => {
    await openWithAudio(page);
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const player = card(page, id);
    await player.getByRole("button", { name: "Play" }).click();
    await expect(player.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(await read(page, id, (audio) => audio.paused)).toBe(false);
    await player.getByRole("button", { name: "Pause" }).click();
    await expect(player.getByRole("button", { name: "Play" })).toBeVisible();
    expect(await read(page, id, (audio) => audio.paused)).toBe(true);
  });

  test("its volume moves with the keys and sets how loud it plays; mute silences it and keeps the level", async ({ page }) => {
    await openWithAudio(page);
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const player = card(page, id);
    const volume = player.getByRole("slider", { name: "Volume" });

    await volume.focus();
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowLeft");
    await expect(volume).toHaveAttribute("aria-valuetext", "80%");
    await expect.poll(() => read(page, id, (audio) => audio.volume)).toBeCloseTo(0.8, 5);

    await player.getByRole("button", { name: "Mute" }).click();
    await expect.poll(() => read(page, id, (audio) => audio.muted)).toBe(true);
    await expect(volume).toHaveAttribute("aria-valuetext", "Muted");
    expect(await read(page, id, (audio) => audio.volume)).toBeCloseTo(0.8, 5);

    await player.getByRole("button", { name: "Unmute" }).click();
    await expect.poll(() => read(page, id, (audio) => audio.muted)).toBe(false);
    await expect(volume).toHaveAttribute("aria-valuetext", "80%");
    expect(await read(page, id, (audio) => audio.volume)).toBeCloseTo(0.8, 5);

    // Muted, moving the slider brings the sound back at the new level.
    await player.getByRole("button", { name: "Mute" }).click();
    await volume.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => read(page, id, (audio) => audio.muted)).toBe(false);
    await expect.poll(() => read(page, id, (audio) => audio.volume)).toBeCloseTo(0.05, 5);
    await expect(player.getByRole("button", { name: "Mute" })).toBeVisible();
  });

  test("remembers the last level on this computer, but never silence", async ({ page }) => {
    await openWithAudio(page);
    const first = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const volume = card(page, first).getByRole("slider", { name: "Volume" });
    await volume.focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowLeft");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("linger.next.audioVolume"))).toBe("0.7");
    // Slid all the way down: silent here, and not remembered.
    await page.keyboard.press("Home");
    await expect.poll(() => read(page, first, (audio) => audio.volume)).toBe(0);
    await expect(card(page, first).getByRole("button", { name: "Unmute" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("linger.next.audioVolume"))).toBe("0.7");

    // The next file starts at the level let go of.
    const next = await post(page, "more rain", "u-jules", { attachments: [{ ...rain, id: "aud-rain-2", url: "/media/aud-rain-2" }] });
    await expect(card(page, next).getByRole("slider", { name: "Volume" })).toHaveAttribute("aria-valuetext", "70%");
    await expect.poll(() => read(page, next, (audio) => audio.volume)).toBeCloseTo(0.7, 5);
    // And unmuting the silenced one brings it back there, not to nothing.
    await card(page, first).getByRole("button", { name: "Unmute" }).click();
    await expect.poll(() => read(page, first, (audio) => audio.volume)).toBeCloseTo(0.7, 5);
  });

  test("a player nobody has turned takes up the last level when it plays; one somebody has keeps its own", async ({ page }) => {
    await openWithAudio(page);
    const a = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const b = await post(page, "more rain", "u-jules", { attachments: [{ ...rain, id: "aud-rain-2", url: "/media/aud-rain-2" }] });
    const level = (id: string) => card(page, id).getByRole("slider", { name: "Volume" });

    await level(a).focus();
    for (let step = 0; step < 2; step += 1) await page.keyboard.press("ArrowLeft");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("linger.next.audioVolume"))).toBe("0.9");
    // B was drawn before A was turned down; it catches up as it starts.
    await expect(level(b)).toHaveAttribute("aria-valuetext", "100%");
    await card(page, b).getByRole("button", { name: "Play" }).click();
    await expect(level(b)).toHaveAttribute("aria-valuetext", "90%");
    await expect.poll(() => read(page, b, (audio) => audio.volume)).toBeCloseTo(0.9, 5);
    await card(page, b).getByRole("button", { name: "Pause" }).click();

    // Turned down itself, B is now what's remembered; A still has its own.
    await level(b).focus();
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowLeft");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("linger.next.audioVolume"))).toBe("0.7");
    await card(page, a).getByRole("button", { name: "Play" }).click();
    await expect(card(page, a).getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(level(a)).toHaveAttribute("aria-valuetext", "90%");
    expect(await read(page, a, (audio) => audio.volume)).toBeCloseTo(0.9, 5);
  });

  test("seeks with the timeline's keys by asking for the part it needs (#222)", async ({ page }) => {
    const store = await openWithAudio(page);
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);
    const timeline = card(page, id).getByRole("slider", { name: "Timeline" });

    await timeline.focus();
    // The end itself, which in WebKit used to ask for bytes past the last one,
    // take the server's 416 as a failed load, and give up (#343).
    await page.keyboard.press("End");
    await expect(timeline).toHaveAttribute("aria-valuetext", "0:04 of 0:04");
    await expect(timeline).toBeFocused();
    await expect(row(page, id).getByRole("alert")).toHaveCount(0);
    for (let step = 0; step < 5; step += 1) await page.keyboard.press("ArrowLeft");
    await expect(timeline).toHaveAttribute("aria-valuetext", "0:03 of 0:04");
    await expect.poll(() => read(page, id, (audio) => audio.currentTime)).toBeCloseTo(3.5, 1);
    await expect(shown(page, id)).toHaveText("0:03 / 0:04");
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(2);
    expect(await read(page, id, (audio) => audio.error)).toBeNull();
    await expect(row(page, id).getByRole("alert")).toHaveCount(0);
    // It came back for a later part of the file, and got it.
    expect(store.ranges.some((range) => !range.startsWith("bytes=0-"))).toBe(true);
  });

  test("one that can't load says so on its controls' line, and loads again in place", async ({ page }) => {
    const store = await openWithAudio(page);
    store.down = true;
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const player = card(page, id);
    const note = player.getByRole("alert");
    await expect(note).toHaveText("Couldn't load this audio.");
    const again = player.getByRole("button", { name: "Load again" });
    await expect(again).toBeVisible();
    // On the line the controls sit on, so the card keeps its height.
    expect(await player.locator(".nx-audio-failed").evaluate((node) => node.getBoundingClientRect().height)).toBe(32);

    store.down = false;
    await again.click();
    await expect(note).toHaveCount(0);
    await expect.poll(() => ready(page, id)).toBeGreaterThanOrEqual(1);
    // The button went; the keyboard is on Play.
    await expect(player.getByRole("button", { name: "Play" })).toBeFocused();

    // Giving up while the keyboard is on the controls hands it to Load again.
    // (Once its bytes are in, a player asks for nothing more, so it gives up
    // by its own event.)
    await sound(page, id).evaluate((audio: HTMLAudioElement) => audio.dispatchEvent(new Event("error")));
    await expect(player.getByRole("button", { name: "Load again" })).toBeFocused();
  });

  test("in a narrow window it keeps mute and gives the volume slider's room to the timeline", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await openWithAudio(page);
    const id = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
    const player = card(page, id);
    await expect(player.getByRole("button", { name: "Mute" })).toBeVisible();
    const fit = await player.evaluate((node) => {
      const edge = node.getBoundingClientRect();
      return {
        width: edge.width,
        outside: [...node.querySelectorAll("[data-kit-control]")].filter((control) => {
          const box = control.getBoundingClientRect();
          return box.width > 0 && (box.left < edge.left || box.right > edge.right);
        }).length,
      };
    });
    expect(fit.outside).toBe(0);
    if (fit.width <= 240) await expect(player.getByRole("slider", { name: "Volume" })).toBeHidden();
    else await expect(player.getByRole("slider", { name: "Volume" })).toBeVisible();
  });

  // For people to look at, not asserted on: resting, part-way with the volume
  // down and a name too long to fit, muted, and failed, at 100% and 200%.
  for (const scale of [1, 2]) {
    test.describe(`at ${scale * 100}%`, () => {
      test.use({ deviceScaleFactor: scale });
      test("review sheet", async ({ page }) => {
        await openWithAudio(page);
        const resting = await post(page, "rain on the porch roof", "u-eli", { attachments: [rain] });
        const moved = await post(page, "the long one", "u-jules", {
          attachments: [{ ...rain, id: "aud-long", url: "/media/aud-long", filename: "a very long recording of the rain on the porch roof, all night.wav" }],
        });
        const long = row(page, moved).getByRole("group");
        await expect.poll(() => long.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
        await long.getByRole("slider", { name: "Timeline" }).focus();
        for (let step = 0; step < 15; step += 1) await page.keyboard.press("ArrowRight");
        await long.getByRole("slider", { name: "Volume" }).focus();
        for (let step = 0; step < 8; step += 1) await page.keyboard.press("ArrowLeft");
        const muted = await post(page, "quiet please", "u-dave", { attachments: [{ ...rain, id: "aud-muted", url: "/media/aud-muted" }] });
        await card(page, muted).getByRole("button", { name: "Mute" }).click();
        // A file of its own that the server refuses, so only this card fails,
        // and fails at once in every engine.
        await page.route(`${SERVER}/media/aud-gone`, (route) => route.fulfill({ status: 503 }));
        const failed = await post(page, "this one won't", "u-callie", { attachments: [{ ...rain, id: "aud-gone", url: "/media/aud-gone" }] });
        await expect(card(page, failed).getByRole("alert")).toBeVisible();
        await page.locator("body").click({ position: { x: 1, y: 1 } });
        await page.mouse.move(0, 0);
        const project = test.info().project.name;
        for (const [name, id] of [["resting", resting], ["moved", moved], ["muted", muted], ["failed", failed]] as const) {
          await row(page, id).screenshot({ path: `test-results/audio/${project}-${scale * 100}-${name}.png`, animations: "disabled" });
        }
      });
    });
  }
});

test.describe("voice and the tabs", () => {
  test("closing the tab of the room you're in voice in, and so the window, never leaves voice (VOICE-3)", async ({ page }) => {
    await open(page, "room=r-general&ptt");
    await expect(page.getByRole("tab", { name: /#general/ })).toBeVisible();
    // The only tab: closing it closes the window too.
    await page.getByRole("button", { name: "Close #general" }).click();
    await expect.poll(() => did(page)).toContain("window:close");
    const voice = intents(await did(page)).filter((intent) => String(intent.kind).startsWith("voice."));
    expect(voice).toEqual([]);
  });
});

test.describe("what the window fetches", () => {
  test("never fetches a linked site or a remote picture itself: cards come from the server (PRIV-8)", async ({ page }) => {
    const elsewhere: string[] = [];
    await page.route(/^https?:\/\/(?!good-company\.example|127\.0\.0\.1|localhost)/, (route) => {
      elsewhere.push(route.request().url());
      return route.abort();
    });
    await open(page);
    await post(page, "look https://millrace-trail.org/river-loop and ![a picture](https://images.example/porch.png) and <img src=https://images.example/x.png>");
    await expect(log(page).locator(".nx-linkcard").last()).toBeVisible();
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("POST /links/preview")).length).toBeGreaterThan(0);
    expect(elsewhere).toEqual([]);
  });
});

test.describe("reading far back", () => {
  const OLDER = 1_200;
  /** Every message #general holds on the server, oldest first. */
  const ORDER = [
    ...Array.from({ length: OLDER }, (_, index) => `l${String(index + 1).padStart(7, "0")}`),
    ...Array.from({ length: 16 }, (_, index) => `m${String(index + 1).padStart(6, "0")}`),
  ];

  const olderPages = async (page: Page) => (await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages?limit=100&before=")).length;
  const newest = (page: Page) => page.getByRole("button", { name: "Back to the newest" });

  /** Scroll back until the room holds `pages` more pages than it opened with. */
  async function readBack(page: Page, pages: number) {
    await open(page, `room=r-general&many=${OLDER}`);
    await expect(row(page, "m000016")).toBeVisible();
    await expect(newest(page)).toHaveCount(0);
    // Up to the top, again on every look: a scroll made while a page is
    // still coming in asks for nothing, as it should.
    await expect
      .poll(
        async () => {
          await log(page).evaluate((node) => {
            node.scrollTop = 0;
          });
          return olderPages(page);
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(pages);
  }

  /** Back far enough to hold more than a room keeps (800), then stop: the newest end is let go. */
  async function readFarBack(page: Page) {
    await readBack(page, 9);
    await expect(newest(page)).toBeVisible();
  }

  test("history far from where you are is let go once you stop, and Back to the newest brings you home (CONV-14, CONV-15)", async ({ page }) => {
    await readFarBack(page);
    // The newest messages aren't held any more: the bottom of what's held is far back.
    await log(page).evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(row(page, "m000016")).toHaveCount(0);
    const newestPages = (await did(page)).filter((line) => line === "GET /rooms/r-general/messages?limit=100 as token-1").length;
    await newest(page).click();
    await expect(row(page, "m000016")).toBeVisible();
    await expect(newest(page)).toHaveCount(0);
    // Home is the newest page again, asked for afresh.
    expect((await did(page)).filter((line) => line === "GET /rooms/r-general/messages?limit=100 as token-1").length).toBe(newestPages + 1);
  });

  test("a read forwards that comes back after Back to the newest leaves the newest page to finish (CONV-14, #266)", async ({ page }) => {
    const asked = async (part: string) => (await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages?") && line.includes(part)).length;
    const newestPage = "?limit=100 as token-1";
    await readFarBack(page);
    // From here every read waits for the test, which fixes the order two of them come back in.
    await page.evaluate(() => window.parity?.holdReads());
    const forwards = await asked("around=");
    // At the bottom of what's held, a read forwards starts, and is still on its way...
    await log(page).evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect.poll(() => asked("around=")).toBe(forwards + 1);
    const newestPages = await asked(newestPage);
    // ...when Back to the newest starts the room over and asks for its newest page.
    await newest(page).click();
    await expect.poll(() => asked(newestPage)).toBe(newestPages + 1);
    // The read forwards comes back first, to a room that isn't the one it was asked for.
    expect(await page.evaluate(() => window.parity?.answerReads("around="))).toBe(1);
    // Anything that looks at the edges of the room while its newest page is still on its way.
    for (let look = 0; look < 5; look += 1) {
      await log(page).evaluate((node) => node.dispatchEvent(new Event("scroll")));
      await page.waitForTimeout(40);
    }
    await page.evaluate(() => window.parity?.answerReads());
    await expect(row(page, "m000016")).toBeVisible();
    await expect(newest(page)).toHaveCount(0);
    // The newest page was asked for once, not again because the late read cleared the way.
    expect(await asked(newestPage)).toBe(newestPages + 1);
  });

  test("reading back down brings the rest back with no gap (CONV-15)", async ({ page }) => {
    // Long by design: it scrolls through 900 messages half a screen at a
    // time, about 20 seconds on CI of the usual 30 (#328).
    test.slow();
    await readFarBack(page);
    const seen = new Set<string>();
    for (let step = 0; step < 400; step += 1) {
      const now = await log(page).evaluate((node) => {
        const ids = [...node.querySelectorAll("[data-message]")].map((message) => message.getAttribute("data-message") ?? "");
        const bottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
        node.scrollTop += Math.floor(node.clientHeight / 2);
        return { ids, bottom };
      });
      for (const id of now.ids) seen.add(id);
      if (now.bottom && seen.has("m000016")) break;
      await page.waitForTimeout(40);
    }
    expect(seen.has("m000016")).toBe(true);
    await expect(newest(page)).toHaveCount(0);
    const first = Math.min(...[...seen].map((id) => ORDER.indexOf(id)));
    const missing = ORDER.slice(first).filter((id) => !seen.has(id));
    expect(missing).toEqual([]);
  });

  test("a room you've left keeps only its newest page, and you come back to the newest (CONV-14)", async ({ page }) => {
    // Six pages back: seven hundred held, all the way to the newest, too few to let go of while you're in it.
    await readBack(page, 6);
    await page.waitForTimeout(800);
    await expect(newest(page)).toHaveCount(0);
    const heldHeight = await log(page).evaluate((node) => node.scrollHeight);
    await page.evaluate(() => window.parity?.open("r-listening"));
    await expect(page.getByRole("tab", { name: "#listening-room" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "#general" }).click();
    await expect(row(page, "m000016")).toBeVisible();
    await expect(newest(page)).toHaveCount(0);
    // A hundred messages' worth, not the seven hundred it held.
    const backHeight = await log(page).evaluate((node) => node.scrollHeight);
    expect(backHeight).toBeLessThan(heldHeight / 3);
  });
});
