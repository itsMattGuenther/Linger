import { expect, type Page, test } from "@playwright/test";

// Screen sharing's screens (SPEC §4.20, #360), concept A: the mark on whoever
// shares, Watch on the room's voice line (and Join beside it when you aren't
// in voice), Share with its two speeds, the screen above the conversation
// with Full screen and Stop watching, the line between them, and the words in
// the screen's place until the picture comes. The chat window and the list
// on the prototype's evening (tests/fixtures/next-chat.tsx, next-list.tsx),
// `?screen=…`. What the buttons do goes on `body[data-did]` (the list's on
// `body[data-opened]`).

async function chat(page: Page, query: string) {
  await page.setViewportSize({ width: 1040, height: 820 });
  await page.goto(`/tests/fixtures/next-chat.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("log")).toBeVisible();
}

const did = (page: Page) => page.locator("body").getAttribute("data-did");

test("somebody sharing is marked on their chip, and Watch sits beside Join when you aren't in voice", async ({ page }) => {
  await chat(page, "?voice=others&screen=shared");
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  await expect(strip.getByText("sharing their screen")).toHaveCount(1);
  await expect(strip.getByRole("button", { name: "Join" })).toBeVisible();
  await strip.getByRole("button", { name: "Watch" }).click();
  await expect.poll(() => did(page)).toContain("watch:s-jules");
});

test("in voice, Share asks which speed and starts at the one picked", async ({ page }) => {
  await chat(page, "?voice=mine&screen=shared");
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  await strip.getByRole("button", { name: "Share your screen" }).click();
  const menu = page.getByRole("menu", { name: "Share your screen" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Sharp text, 30 fps", "Smooth motion, 60 fps"]);
  // The words fit the menu: none is cut short.
  for (const item of await menu.getByRole("menuitem").all()) {
    expect(await item.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  await menu.getByRole("menuitem", { name: "Smooth motion, 60 fps" }).click();
  await expect.poll(() => did(page)).toContain("share:60");
  // Picking closes it: left open, it came back when the share ended.
  await expect(menu).toBeHidden();
});

test("while you share, Share is lit and stops it", async ({ page }) => {
  await chat(page, "?voice=mine&screen=sharing");
  const stop = page.getByRole("button", { name: "Stop sharing your screen" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await stop.click();
  await expect.poll(() => did(page)).toContain("stop sharing");
});

test("the screen sits above the conversation, its picture drawn, and Stop watching closes it", async ({ page }) => {
  await chat(page, "?voice=mine&screen=watching");
  const stage = page.getByRole("region", { name: "Jules's screen" });
  await expect(stage).toBeVisible();
  await expect(stage.getByText("with Eli watching")).toBeVisible();
  // Above the conversation, never over it.
  const stageBox = await stage.boundingBox();
  const logBox = await page.getByRole("log").boundingBox();
  expect(stageBox && logBox && stageBox.y + stageBox.height <= logBox.y + 1).toBe(true);
  // The picture is drawn, its shape kept: the canvas says 16:9 and is shown.
  const canvas = stage.getByRole("img", { name: "Jules's screen" });
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node) => (node instanceof HTMLCanvasElement ? [node.width, node.height] : []))).toEqual([1600, 900]);
  await stage.getByRole("button", { name: "Stop watching" }).click();
  await expect.poll(() => did(page)).toContain("stop watching");
});

test("Full screen fills the window and Escape leaves it", async ({ page }) => {
  await chat(page, "?voice=mine&screen=watching");
  const stage = page.getByRole("region", { name: "Jules's screen" });
  await stage.getByRole("button", { name: "Full screen" }).click();
  await expect(stage).toHaveAttribute("data-full", "yes");
  const box = await stage.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1040, height: 820 });
  await page.keyboard.press("Escape");
  await expect(stage).not.toHaveAttribute("data-full", "yes");
});

test("F and a double-click on the picture fill the window and give it back, and F typed in the box is just a letter", async ({ page }) => {
  await chat(page, "?voice=mine&screen=watching");
  const stage = page.getByRole("region", { name: "Jules's screen" });
  const full = stage.getByRole("button", { name: "Full screen" });
  await expect(full).toHaveAttribute("aria-keyshortcuts", "F");
  // The cursor in the message box: F is typed, and the screen stays put.
  const box = page.getByLabel("Message in #general");
  await box.click();
  await page.keyboard.press("f");
  await expect(box).toHaveValue("f");
  await expect(stage).not.toHaveAttribute("data-full", "yes");
  // Out of the box, F fills the window, and F again gives it back.
  await box.evaluate((node: HTMLElement) => node.blur());
  await page.keyboard.press("f");
  await expect(stage).toHaveAttribute("data-full", "yes");
  await page.keyboard.press("f");
  await expect(stage).not.toHaveAttribute("data-full", "yes");
  // A double-click on the picture does the same.
  const picture = stage.getByRole("img", { name: "Jules's screen" });
  await picture.dblclick();
  await expect(stage).toHaveAttribute("data-full", "yes");
  await picture.dblclick();
  await expect(stage).not.toHaveAttribute("data-full", "yes");
});

test("with F as your push-to-talk key, F keeps the microphone and leaves the screen alone", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("linger.voice.pushToTalkKey", "KeyF"));
  await chat(page, "?voice=mine&screen=watching");
  const stage = page.getByRole("region", { name: "Jules's screen" });
  await expect(stage.getByRole("button", { name: "Full screen" })).not.toHaveAttribute("aria-keyshortcuts", "F");
  await page.keyboard.press("f");
  await page.waitForTimeout(200);
  await expect(stage).not.toHaveAttribute("data-full", "yes");
});

test("the line between the screen and the conversation moves it, and the conversation keeps room", async ({ page }) => {
  await chat(page, "?voice=mine&screen=watching");
  const line = page.getByRole("separator", { name: "Space between the screen and the conversation" });
  const stage = page.getByRole("region", { name: "Jules's screen" });
  const before = (await stage.boundingBox())?.height ?? 0;
  await line.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await stage.boundingBox())?.height ?? 0).toBeGreaterThan(before);
  // As far down as it goes, the conversation still has room.
  await page.keyboard.press("End");
  const log = await page.getByRole("log").boundingBox();
  expect(log?.height ?? 0).toBeGreaterThan(60);
  // And back to half.
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.abs(((await stage.boundingBox())?.height ?? 0) - before)).toBeLessThan(40);
});

for (const [status, words] of [
  ["waiting", "Waiting for Jules's screen…"],
  ["unplayable", "This device can't play Jules's screen."],
  ["ended", "Jules stopped sharing. If they share again, it opens here."],
  ["lost", "Lost the connection to Jules's screen."],
] as const) {
  test(`until the picture comes, and when it can't, the screen says so: ${status}`, async ({ page }) => {
    await chat(page, `?voice=mine&screen=${status}`);
    const stage = page.getByRole("region", { name: "Jules's screen" });
    await expect(stage.getByRole("status")).toHaveText(words);
    await expect(stage.getByRole("img")).toBeHidden();
  });
}

test("sharing from a popped-out window, your box sits under its voice line: a copy, who's watching, the eye and Stop", async ({ page }) => {
  await chat(page, "?voice=mine&screen=sharing&box");
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  const box = page.getByRole("group", { name: "Your screen" });
  await expect(box).toBeVisible();
  // Under the voice line, above the conversation, never over it.
  const line = await strip.boundingBox();
  const shown = await box.boundingBox();
  const log = await page.getByRole("log").boundingBox();
  expect(line && shown && shown.y >= line.y + line.height - 1).toBe(true);
  expect(shown && log && shown.y + shown.height <= log.y + 1).toBe(true);
  // The copy plays beside the words, at a screen's shape.
  const copy = box.locator("video");
  await expect(copy).toBeVisible();
  const frame = await box.locator(".nx-sharing-preview").boundingBox();
  expect(frame && Math.abs(frame.width / frame.height - 16 / 9) < 0.05).toBe(true);
  await expect(box.getByText("Sharing your screen")).toBeVisible();
  await expect(box.getByRole("status")).toHaveText("Eli and Dave are watching");
  // The eye hides it: one line, as tall as the voice line, the words still there.
  await box.getByRole("button", { name: "Show the preview" }).click();
  await expect(copy).toHaveCount(0);
  await expect.poll(async () => Math.round((await box.boundingBox())?.height ?? 0)).toBe(Math.round(line?.height ?? -1));
  await expect(box.getByRole("status")).toHaveText("Eli and Dave are watching");
  await box.getByRole("button", { name: "Show the preview" }).click();
  await expect(box.locator("video")).toBeVisible();
  await box.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => did(page)).toContain("stop sharing");
});

test("a share from a popped-out window that ended by itself says why under its voice line", async ({ page }) => {
  await chat(page, "?voice=mine&screen=stopped");
  const why = page.getByText("Linger couldn't read the screen you picked, so sharing stopped.");
  await expect(why).toBeVisible();
  const line = await page.getByRole("group", { name: "Voice in this conversation" }).boundingBox();
  const said = await why.boundingBox();
  expect(line && said && said.y >= line.y + line.height - 1).toBe(true);
});

test("out of voice, an ended screen only says they stopped: their next share opens only for somebody still there", async ({ page }) => {
  await chat(page, "?screen=ended");
  await expect(page.getByRole("region", { name: "Jules's screen" }).getByRole("status")).toHaveText("Jules stopped sharing.");
});

test("the list marks the room and the person sharing, and says so in words", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/tests/fixtures/next-list.html?voice&screen=shared");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("button", { name: /^#general, .*a screen shared/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Jules, .*sharing their screen/ }).first()).toBeVisible();
  // Nobody else is marked.
  await expect(page.getByRole("button", { name: /^Eli, .*sharing their screen/ })).toHaveCount(0);
});

test("your share in the voice bar: a copy, who's watching by name, and Stop", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/tests/fixtures/next-list.html?voice&screen=sharing");
  const box = page.getByRole("group", { name: "Your screen" });
  await expect(box.getByText("Sharing your screen")).toBeVisible();
  // The copy runs across the box at a screen's shape.
  const copy = box.locator("video");
  await expect(copy).toBeVisible();
  const size = await copy.boundingBox();
  const across = await box.boundingBox();
  expect((size?.width ?? 0) / (across?.width ?? 1)).toBeGreaterThan(0.85);
  expect(Math.abs((size?.width ?? 0) / (size?.height ?? 1) - 16 / 9)).toBeLessThan(0.05);
  await expect(box.getByRole("status")).toHaveText("Eli and Jules are watching");
  await box.getByRole("button", { name: "Stop" }).click();
  // The list page writes what was pressed on `body[data-opened]`.
  await expect.poll(() => page.locator("body").getAttribute("data-opened")).toContain("stop sharing");
});

test("on a phone the screen runs edge to edge at its own shape, and sideways it fills the phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/next-chat.html?voice=mine&screen=watching&shell=phone");
  const stage = page.getByRole("region", { name: "Jules's screen" });
  await expect(stage).toBeVisible();
  // No line to drag on a phone.
  await expect(page.getByRole("separator", { name: "Space between the screen and the conversation" })).toHaveCount(0);
  const canvas = await stage.getByRole("img").boundingBox();
  expect(canvas?.width).toBe(390);
  expect(Math.round(canvas?.height ?? 0)).toBe(Math.round((390 * 9) / 16));
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => await stage.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
});

test("a share that ended by itself says why in the voice bar", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/tests/fixtures/next-list.html?voice&screen=stopped");
  const bar = page.getByRole("region", { name: /^In voice in #general/ });
  await expect(bar.getByRole("status")).toHaveText("Three people are sharing here already, so yours didn't start.");
  await expect(bar.getByRole("group", { name: "Your screen" })).toHaveCount(0);
});

test("the eye hides your share's copy and shows it again, and it stays as you left it", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/tests/fixtures/next-list.html?voice&screen=sharing");
  const box = page.getByRole("group", { name: "Your screen" });
  const eye = box.getByRole("button", { name: "Show the preview" });
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await expect(box.locator("video")).toBeVisible();
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  // Hidden is gone, not just out of sight: nothing plays it.
  await expect(box.locator("video")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: "Your screen" }).locator("video")).toHaveCount(0);
  await page.getByRole("group", { name: "Your screen" }).getByRole("button", { name: "Show the preview" }).click();
  await expect(page.getByRole("group", { name: "Your screen" }).locator("video")).toBeVisible();
});
