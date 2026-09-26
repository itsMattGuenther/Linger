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

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });
const log = (page: Page) => page.getByRole("log");
/** The row of the message with this id. */
const row = (page: Page, id: string) => page.locator(`[data-message="${id}"]`);

async function post(page: Page, body: string, author = "u-eli", extra: Record<string, unknown> = {}): Promise<string> {
  const id = await page.evaluate(([words, who, more]) => window.parity?.post("r-general", who, words, more) ?? "", [body, author, extra] as const);
  await expect(row(page, id)).toBeVisible();
  return id;
}

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
    expect(offered.map((label) => label.trim())).toEqual(["Reply", "Delete"]);
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

  test("video gets its poster and a player, sound a player, anything else one line and a download button (FILE-5)", async ({ page }) => {
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

    const sound = row(page, id).locator("audio");
    await expect(sound).toHaveJSProperty("controls", true);
    await expect(sound).toHaveAttribute("src", `${SERVER}/media/aud-1`);
    const soundCard = row(page, id).locator(".nx-att-card").filter({ has: page.locator("audio") });
    await expect(soundCard).toContainText("rain-sounds.mp3");
    await expect(soundCard).toContainText("1:02:05");

    // Anything else is never shown in the app: one line, and a way to download it
    // (what the download does is FILE-6's).
    const other = row(page, id).locator(".nx-att-card").filter({ hasText: "wiring.pdf" });
    await expect(other.locator("iframe, embed, object, img, video, audio")).toHaveCount(0);
    await expect(other.getByRole("button", { name: /Download/ })).toBeVisible();
  });
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

  test("reading back down brings the rest back with no gap (CONV-15)", async ({ page }) => {
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
