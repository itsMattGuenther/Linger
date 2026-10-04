import { expect, type Page, test } from "@playwright/test";

// Voice messages on the phone (#401, SPEC §4.15): the page records, with the
// web view's own microphone and its WebCodecs Opus encoder
// (app/chat/recorders.ts), into the same WebM file the desktop makes. The
// phone's engine is Android's web view, which is Chromium; Chromium stands in
// a fake microphone playing a tone. The panel itself, sending, and a voice
// message in the conversation are next-chat-parity.spec.ts's.

// Chromium only, and skipped before a browser starts: WebKit won't start at
// all with Chromium's fake-microphone switches below.
test.skip(({ browserName }) => browserName !== "chromium", "The phone's engine is Chromium, and only it stands in a microphone here.");

test.use({
  viewport: { width: 411, height: 914 },
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The phone, in #general, once every connection is in (next-side.spec.ts says why, #355). */
async function inGeneral(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one&shell=phone");
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

const panel = (page: Page) => page.getByRole("group", { name: "Voice message for #general" });

test("records from the phone's own microphone, lines moving, and plays back as the same kind of file", async ({ page }) => {
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();

  // The tone moves the lines: some are taller than silence's dots.
  await expect
    .poll(() => panel(page).locator(".nx-voicemsg-lines i").evaluateAll((lines) => Math.max(...lines.map((line) => line.getBoundingClientRect().height))), { timeout: 5000 })
    .toBeGreaterThan(8);
  await page.waitForTimeout(1600);
  await panel(page).getByRole("button", { name: "Stop" }).click();
  await expect(panel(page).getByRole("button", { name: "Send voice message" })).toBeVisible();

  // A real file: WebM, Opus, as long as it was recorded, and this engine plays it.
  const heard = await panel(page)
    .locator("audio")
    .evaluate(async (audio: HTMLAudioElement) => {
      const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
      const head = Array.from(bytes.slice(0, 4));
      // The page's own AudioContext is the test page's stand-in for hearing sounds; an offline one decodes.
      const decoded = await new OfflineAudioContext(1, 48_000, 48_000).decodeAudioData(bytes.slice().buffer);
      return { head, seconds: decoded.duration, webm: new TextDecoder().decode(bytes.slice(0, 64)).includes("webm") };
    });
  expect(heard.head).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(heard.webm).toBe(true);
  expect(heard.seconds).toBeGreaterThan(1.2);
  expect(heard.seconds).toBeLessThan(6);
});

test("a phone that won't give the microphone says so in words, and Record can be tried again", async ({ page }) => {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await inGeneral(page);
  const mic = page.getByRole("button", { name: "Record a voice message" });
  // An engine that can't record in the page at all offers no button.
  if ((await mic.count()) === 0) return;
  await mic.click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Linger isn't allowed to use the microphone.");
  await expect(panel(page).getByRole("button", { name: "Record" })).toBeEnabled();
});
