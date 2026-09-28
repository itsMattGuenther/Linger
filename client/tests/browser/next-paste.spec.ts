import { expect, type Page, test } from "@playwright/test";

// Pasting a picture into the message box (#276, core/chat/paste.ts), on the
// real chat window (tests/fixtures/next-chat-parity.tsx): the real
// ChatWindow, store and upload code on a fake desktop and server. Each engine
// the app ships on is named by its user agent, which is how the box tells
// them apart.

test.use({ viewport: { width: 780, height: 820 } });

const SERVER = "https://good-company.example";
/** Windows: WebView2 is Chromium, whose paste event carries a clipboard picture as a file. */
const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
/** Linux: WebKitGTK, as the packaged app reports itself, which never shows the page a clipboard picture. */
const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";

/** A real 2×2 PNG, since Chromium decodes a picture before it takes it onto its clipboard. */
const PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd,
  0xd4, 0x9a, 0x73, 0x00, 0x00, 0x00, 0x16, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xb4, 0xd2, 0xb5, 0x67, 0x60, 0x60, 0x60, 0x62, 0x60, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x07,
  0xed, 0x00, 0xaa, 0xe6, 0x1b, 0x64, 0xa8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;
/** `pasted-image-<date>-<time>.png`, in the computer's own time. */
const PASTED = /^pasted-image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/;

async function open(page: Page, query = "room=r-general") {
  await page.route(`${SERVER}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.goto(`/tests/fixtures/next-chat-parity.html?${query}`);
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const files = (page: Page) => page.getByRole("list", { name: "Files for this message" }).getByRole("listitem");
const asked = async (page: Page) => (await did(page)).filter((line) => line === "clipboard").length;

/**
 * A paste on the box, carrying what an engine would hand the page: `picture`
 * as a file named the way Chromium names every clipboard picture, and these
 * words. Says whether the box cancelled it (took it over from the engine).
 */
async function paste(page: Page, { picture = false, words = {} }: { picture?: boolean; words?: Record<string, string> }): Promise<boolean> {
  return box(page).evaluate(
    (field, [bytes, withPicture, formats]) => {
      const data = new DataTransfer();
      for (const [format, value] of Object.entries(formats)) data.setData(format, value);
      if (withPicture) data.items.add(new File([Uint8Array.from(bytes)], "image.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      return !field.dispatchEvent(event);
    },
    [PNG, picture, words] as const,
  );
}

/** Sends what's in the box, and waits for the attachment it carried to show in the conversation. */
async function sendsThePicture(page: Page, body: string) {
  await expect.poll(async () => (await did(page)).includes("POST /uploads/f-1/complete as token-1")).toBe(true);
  await expect(files(page).getByRole("progressbar")).toHaveCount(0);
  await box(page).press("Enter");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("sent:")).at(-1)).toBe(
    `sent:${JSON.stringify({ body, reply_to: null, attachment_ids: ["f-1"] })}`,
  );
  await expect(files(page)).toHaveCount(0);
  const posted = page.getByRole("log").getByRole("button", { name: /^Open pasted-image-/ });
  await expect(posted).toBeVisible();
  expect((await posted.getAttribute("aria-label"))?.replace(/^Open /, "")).toMatch(PASTED);
}

test.describe("on Windows, where the paste carries the picture (#276)", () => {
  test.use({ userAgent: WEBVIEW2 });

  test("a pasted picture goes on the draft like an added file, leaves the words alone, and goes up and out with the message", async ({ page }) => {
    await open(page);
    await box(page).fill("the view from the porch");
    expect(await paste(page, { picture: true })).toBe(true);
    await expect(files(page)).toHaveCount(1);
    expect(await files(page).locator(".nx-composer-file-name").textContent()).toMatch(PASTED);
    await expect(box(page)).toHaveValue("the view from the porch");
    // The same path as the + button: a slot, the bytes, then complete.
    await expect.poll(async () => (await did(page)).includes("POST /uploads as token-1")).toBe(true);
    await sendsThePicture(page, "the view from the porch");
    // The page had the picture itself: the desktop shell was never asked.
    expect(await asked(page)).toBe(0);
  });

  test("a picture copied with words beside it goes on as the picture, and the words stay out", async ({ page }) => {
    await open(page);
    // A browser's Copy Image: the picture, its address and markup.
    const cancelled = await paste(page, {
      picture: true,
      words: { "text/plain": "https://millrace-trail.org/heron.png", "text/html": '<img src="https://millrace-trail.org/heron.png">' },
    });
    expect(cancelled).toBe(true);
    await expect(files(page)).toHaveCount(1);
    await expect(box(page)).toHaveValue("");
  });

  test("words are left to the engine, and nothing is attached", async ({ page }) => {
    await open(page);
    expect(await paste(page, { words: { "text/plain": "see you at eight" } })).toBe(false);
    await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
    expect(await asked(page)).toBe(0);
  });

  test.describe("with the engine's own clipboard and Ctrl+V", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "Chromium is the engine WebView2 is; only it lets a test write to its clipboard");

    test.beforeEach(async ({ context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    });

    test("a copied picture pastes onto the draft", async ({ page }) => {
      await open(page);
      await page.evaluate(async (bytes) => {
        const picture = new Blob([Uint8Array.from(bytes)], { type: "image/png" });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": picture })]);
      }, PNG);
      await box(page).click();
      await page.keyboard.press("ControlOrMeta+V");
      await expect(files(page)).toHaveCount(1);
      expect(await files(page).locator(".nx-composer-file-name").textContent()).toMatch(PASTED);
      await expect(box(page)).toHaveValue("");
      await sendsThePicture(page, "");
    });

    test("copied words paste as words", async ({ page }) => {
      await open(page);
      await page.evaluate(() => navigator.clipboard.writeText("see you at eight"));
      await box(page).fill("ok, ");
      await page.keyboard.press("ControlOrMeta+V");
      await expect(box(page)).toHaveValue("ok, see you at eight");
      await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
    });
  });
});

test.describe("on Linux, where the desktop shell has the picture (#276)", () => {
  test.use({ userAgent: WEBKITGTK });

  test("a paste with nothing the page can see asks the shell, and its picture goes on the draft and out with the message", async ({ page }) => {
    await open(page);
    await page.evaluate((bytes) => window.parity?.clipboard(bytes), PNG);
    await box(page).fill("the view from the porch");
    // What WebKitGTK hands the page for a screenshot: nothing at all.
    expect(await paste(page, {})).toBe(true);
    await expect(files(page)).toHaveCount(1);
    expect(await asked(page)).toBe(1);
    expect(await files(page).locator(".nx-composer-file-name").textContent()).toMatch(PASTED);
    await expect(box(page)).toHaveValue("the view from the porch");
    await sendsThePicture(page, "the view from the porch");
  });

  test("a picture copied with words beside it goes on as the picture, and the words stay out", async ({ page }) => {
    await open(page);
    await page.evaluate((bytes) => window.parity?.clipboard(bytes), PNG);
    await box(page).fill("look");
    // Firefox's Copy Image: WebKitGTK shows the page the address, not the picture.
    expect(await paste(page, { words: { "text/plain": "https://millrace-trail.org/heron.png" } })).toBe(true);
    await expect(files(page)).toHaveCount(1);
    await expect(box(page)).toHaveValue("look");
  });

  test("words with no picture on the clipboard go in at the caret, as a paste would put them", async ({ page }) => {
    await open(page);
    await box(page).fill("ok, bring chairs");
    await box(page).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(4, 4));
    expect(await paste(page, { words: { "text/plain": "see you at eight\r\nand " } })).toBe(true);
    await expect(box(page)).toHaveValue("ok, see you at eight\nand bring chairs");
    expect(await box(page).evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe("ok, see you at eight\nand ".length);
    await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
    expect(await asked(page)).toBe(1);
  });

  test("a paste with no picture and no words attaches nothing and leaves the box as it was", async ({ page }) => {
    await open(page);
    await box(page).fill("still here");
    expect(await paste(page, {})).toBe(true);
    await expect.poll(() => asked(page)).toBe(1);
    await expect(box(page)).toHaveValue("still here");
    await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
  });

  test("a middle-click paste is left to the engine, even with a picture on the clipboard", async ({ page }) => {
    await open(page);
    await page.evaluate((bytes) => window.parity?.clipboard(bytes), PNG);
    await box(page).dispatchEvent("mousedown", { button: 1 });
    expect(await paste(page, { words: { "text/plain": "the selection" } })).toBe(false);
    await expect(page.getByRole("list", { name: "Files for this message" })).toHaveCount(0);
    expect(await asked(page)).toBe(0);
    // The next paste is an ordinary one again.
    expect(await paste(page, {})).toBe(true);
    await expect(files(page)).toHaveCount(1);
  });

  test("a pasted picture the server won't take says so on that file, as an added one does", async ({ page }) => {
    await open(page, "room=r-general&uploadrefuse");
    await page.evaluate((bytes) => window.parity?.clipboard(bytes), PNG);
    expect(await paste(page, {})).toBe(true);
    await expect(files(page)).toContainText("That file is bigger than this server takes.");
  });
});
