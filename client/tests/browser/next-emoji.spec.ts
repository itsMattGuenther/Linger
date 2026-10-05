import { expect, type Page, test } from "@playwright/test";

import { still } from "./still";

// Emoji (#359): every emoji in the picker, `:name:` in the message box, a
// server's own drawn in messages, and the host adding them in Settings. On
// the conversation fixture (tests/fixtures/next-chat.tsx), whose server has
// seven of its own (tests/fixtures/next/evening.ts `customEmoji`), and the
// Settings fixture.

test.use({ viewport: { width: 900, height: 760 } });

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

async function chat(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-chat.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
}

const box = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const picker = (page: Page) => page.getByRole("dialog", { name: "Emoji" });
const lastMessage = (page: Page) => page.getByRole("log").locator(".nx-msg").last();

/** Send what's typed, and wait for it to be the newest message. */
async function send(page: Page, words: string) {
  await box(page).fill(words);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
}

test.describe("the picker", () => {
  test("has every emoji, the server's own first, and finds one by name or by a word for it", async ({ page }) => {
    await chat(page);
    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    await expect(picker(page).getByRole("region", { name: "Smileys & emotion" }).getByRole("button").first()).toBeVisible();
    // The server's own, under its name, then Unicode's groups.
    await expect(picker(page).getByRole("region", { name: "The Good Company" }).getByRole("button")).toHaveCount(7);
    for (const group of ["People & body", "Animals & nature", "Food & drink", "Flags"]) {
      await expect(picker(page).getByRole("region", { name: group })).toHaveCount(1);
    }
    expect(await picker(page).locator(".nx-emoji-cell").count()).toBeGreaterThan(1500);

    const find = picker(page).getByRole("searchbox", { name: "Find an emoji" });
    await expect(find).toBeFocused();
    await find.fill("hello");
    await expect(picker(page).getByRole("button", { name: "waving hand" })).toBeVisible();
    await find.fill("parrot");
    await expect(picker(page).getByRole("region", { name: "Found" }).getByRole("button").first()).toHaveAccessibleName(":party_parrot:");
  });

  test("puts a Unicode emoji in the box, and a server's own as its :name:, and remembers both", async ({ page }) => {
    await chat(page);
    await box(page).fill("great");
    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    await picker(page).getByRole("searchbox", { name: "Find an emoji" }).fill("fire");
    await picker(page).getByRole("button", { name: "fire", exact: true }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(box(page)).toHaveValue("great🔥");

    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    await picker(page).getByRole("region", { name: "The Good Company" }).getByRole("button", { name: ":party_parrot:" }).click();
    await expect(box(page)).toHaveValue("great🔥 :party_parrot: ");

    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    const recent = picker(page).getByRole("region", { name: "Recently used" }).getByRole("button");
    await expect(recent).toHaveCount(2);
    await expect(recent.first()).toHaveAccessibleName(":party_parrot:");
    await expect(recent.nth(1)).toHaveAccessibleName("fire");
  });

  test("a skin tone chosen once goes on every emoji that has one, and stays chosen", async ({ page }) => {
    await chat(page);
    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    await picker(page).getByRole("button", { name: "Skin tone: No skin tone" }).click();
    await picker(page).getByRole("button", { name: "Medium skin tone" }).click();
    await picker(page).getByRole("searchbox", { name: "Find an emoji" }).fill("wave");
    await picker(page).getByRole("button", { name: "waving hand" }).click();
    await expect(box(page)).toHaveValue("👋🏽");

    await page.reload();
    await expect(page.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    await expect(picker(page).getByRole("button", { name: "Skin tone: Medium skin tone" })).toBeVisible();
  });

  test("Escape closes it and gives the box back; arrows move through the grid", async ({ page }) => {
    await chat(page);
    await page.getByRole("button", { name: "Emoji", exact: true }).click();
    const find = picker(page).getByRole("searchbox", { name: "Find an emoji" });
    await find.fill("cat");
    // The list loads when the picker opens; Down has nothing to go to before.
    await expect(picker(page).getByRole("button", { name: "cat face", exact: true })).toBeVisible();
    await find.press("ArrowDown");
    const first = picker(page).locator(".nx-emoji-cell").first();
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(picker(page).locator(".nx-emoji-cell").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(box(page)).toBeFocused();
  });
});

test.describe("shortcodes in the box", () => {
  test("a colon and two letters offers emoji, the server's own first, and Enter puts one in without sending", async ({ page }) => {
    await chat(page);
    await box(page).click();
    await box(page).pressSequentially("this is the :part");
    const list = page.getByRole("listbox", { name: "Emoji" });
    await expect(list.getByRole("option").first()).toHaveAccessibleName("party_parrot, this server's emoji");
    await expect(list.getByRole("option", { name: /^partying_face/ })).toHaveCount(1);
    await box(page).press("Enter");
    await expect(box(page)).toHaveValue("this is the :party_parrot: ");
    expect(await did(page)).not.toContain("send");

    await box(page).pressSequentially(":thu");
    await box(page).press("ArrowDown");
    await box(page).press("ArrowUp");
    await box(page).press("Tab");
    await expect(box(page)).toHaveValue("this is the :party_parrot: 👍 ");
  });

  test("a finished :name: becomes the emoji as it's typed; a server's own stays its name; a time is left alone", async ({ page }) => {
    await chat(page);
    await box(page).click();
    await box(page).pressSequentially("sounds good :thumbsup: at 12:30");
    await expect(box(page)).toHaveValue("sounds good 👍 at 12:30");
    await box(page).fill("");
    await box(page).pressSequentially(":smiley::fire: :party_parrot:");
    await expect(box(page)).toHaveValue("😃🔥 :party_parrot:");
  });

  test("a :name: finished before the list has loaded becomes the emoji when it arrives, and typing carries on where it was", async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/src/lib/emoji/data.ts*", async (route) => {
      await held;
      await route.continue();
    });
    await chat(page);
    await box(page).click();
    await box(page).pressSequentially("sounds good :thumbsup: at 1");
    await expect(box(page)).toHaveValue("sounds good :thumbsup: at 1");
    // The list arrives while the time is still being typed.
    release();
    await box(page).pressSequentially("2:30 ok");
    await expect(box(page)).toHaveValue("sounds good 👍 at 12:30 ok");
  });

  test("Escape closes the list and keeps what was typed", async ({ page }) => {
    await chat(page);
    await box(page).click();
    await box(page).pressSequentially(":smi");
    await expect(page.getByRole("listbox", { name: "Emoji" })).toBeVisible();
    await box(page).press("Escape");
    await expect(page.getByRole("listbox", { name: "Emoji" })).toHaveCount(0);
    await expect(box(page)).toHaveValue(":smi");
  });
});

test.describe("in messages", () => {
  test("a server's own emoji is drawn as its picture, named for a screen reader, and one it doesn't have stays words", async ({ page }) => {
    await chat(page);
    await send(page, "see you friday :porch_light: :not_here:");
    const words = lastMessage(page).locator(".nx-text");
    await expect(words.getByRole("img", { name: ":porch_light:" })).toBeVisible();
    await expect(words).toContainText(":not_here:");
    await expect(words).not.toHaveAttribute("data-jumbo", "yes");
  });

  test("a few emoji and nothing else are drawn big, back to back too", async ({ page }) => {
    await chat(page);
    await send(page, ":party_parrot::party_parrot::fire:");
    const words = lastMessage(page).locator(".nx-text");
    await expect(words).toHaveAttribute("data-jumbo", "yes");
    await expect(words.getByRole("img", { name: ":party_parrot:" })).toHaveCount(2);
    // Measured once the message has settled: a sent message is swapped for
    // the server's copy, and a measure in between finds nothing.
    // Half again a line of words (20px) or more.
    await expect.poll(async () => (await words.getByRole("img").first().boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(30);

    await send(page, "😂😂");
    await expect(lastMessage(page).locator(".nx-text")).toHaveAttribute("data-jumbo", "yes");
    await send(page, "😂 ok");
    await expect(lastMessage(page).locator(".nx-text")).not.toHaveAttribute("data-jumbo", "yes");
  });

  test("on a server with no emoji of its own, :name: is the words typed", async ({ page }) => {
    await chat(page, "?noemoji");
    await send(page, "hi :party_parrot:");
    await expect(lastMessage(page).locator(".nx-text")).toContainText("hi :party_parrot:");
    await expect(lastMessage(page).getByRole("img", { name: ":party_parrot:" })).toHaveCount(0);
  });
});

test.describe("the host's Emoji settings", () => {
  async function settings(page: Page, query = "") {
    await page.goto(`/tests/fixtures/next-settings.html?section=emoji${query}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { name: "This Server's Emoji" })).toBeVisible();
  }
  const list = (page: Page) => page.getByRole("list", { name: "This server's emoji" });

  /** A plain PNG, `size` pixels square: big enough to need shrinking at 600. */
  async function png(page: Page, size: number): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    const base64 = await page.evaluate(async (edge) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = edge;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#e8636f";
      ctx.fillRect(0, 0, edge, edge);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((made) => done(made!), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    }, size);
    return { name: "Big Sunset Picture.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
  }

  test("pictures chosen become emoji at once, named from their files, a big one made small", async ({ page }) => {
    await settings(page);
    await expect(list(page).getByRole("listitem")).toHaveCount(7);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose pictures" }).click();
    await (await chooser).setFiles(await png(page, 600));
    await expect(list(page).getByRole("listitem")).toHaveCount(8);
    await expect(list(page)).toContainText(":big_sunset_picture:");
    expect(await did(page)).toContain("emoji-add:big_sunset_picture:image/png:fits");
    await expect(page.getByText("8 of 200 used.")).toBeVisible();
  });

  test("a name already taken gets a number", async ({ page }) => {
    await settings(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose pictures" }).click();
    await (await chooser).setFiles({ ...(await png(page, 64)), name: "brb.png" });
    await expect(list(page)).toContainText(":brb_2:");
  });

  test("renaming checks the name as it's typed, and saves", async ({ page }) => {
    await settings(page);
    const row = list(page).getByRole("listitem").filter({ hasText: ":gg:" });
    await row.getByRole("button", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Name" });
    await field.fill("Good Game");
    await expect(page.getByText("A name is 2 to 32 lowercase letters, digits or underscores.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await field.fill("brb");
    await expect(page.getByText("There's already an emoji called :brb:.")).toBeVisible();
    await field.fill("good_game");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => did(page)).toContain("emoji-rename:e-gg:good_game");
    await expect(list(page)).toContainText(":good_game:");
  });

  test("removing asks first, and says what happens to messages that used it", async ({ page }) => {
    await settings(page);
    const row = list(page).getByRole("listitem").filter({ hasText: ":lamp:" });
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(row).toContainText("Remove :lamp:? Messages that used it show :lamp: as words from now on.");
    await row.getByRole("button", { name: "Keep it" }).click();
    await expect(list(page).getByRole("listitem")).toHaveCount(7);
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Yes, remove" }).click();
    await expect.poll(async () => did(page)).toContain("emoji-remove:e-lamp");
    await expect(list(page).getByRole("listitem")).toHaveCount(6);
  });

  test("a server with none says where the first will show", async ({ page }) => {
    await settings(page, "&noemoji");
    await expect(page.getByText("No emoji yet. The first one you add is in everyone's emoji picker at once, under The Good Company.")).toBeVisible();
  });

  test("a picture that isn't one is refused in words, and can be let go", async ({ page }) => {
    await settings(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose pictures" }).click();
    await (await chooser).setFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not a picture") });
    const adding = page.getByRole("list", { name: "Being added" });
    await expect(adding).toContainText("That picture couldn't be read.");
    await adding.getByRole("button", { name: "Forget :notes:" }).click();
    await expect(adding).toHaveCount(0);
  });
});

test("the picker's cells are its own size, and a server's picture is as big as a glyph there", async ({ page }) => {
  await chat(page);
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
  const own = picker(page).getByRole("region", { name: "The Good Company" }).getByRole("button").first();
  await still(own);
  const cell = await own.boundingBox();
  expect(cell?.width).toBe(32);
  expect(cell?.height).toBe(32);
});
