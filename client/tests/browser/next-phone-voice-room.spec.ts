import { expect, type Page, test } from "@playwright/test";

// Voice rooms on the phone (#429, SPEC §4.15). On the phone voice runs in the
// page (src/lib/pageVoice.ts), on the web engine's own WebRTC, and here it
// meets a real connection standing in for the server's forwarding
// (tests/fixtures/next/sfu.ts): real ICE, DTLS and RTP inside the browser.
// Eli's m-line carries a tone and Jules's silence; the phone's microphone is
// a tone made in the page. What this can't prove is a real network or a
// real phone's speaker: those are the Pixel's checks (TASKS T-1606).

// The phone's engine is Android's web view, which is Chromium. WebKit gets
// its turn with the iPhone.
test.skip(({ browserName }) => browserName !== "chromium", "The phone's engine is Chromium; the iPhone's WebKit comes with the iPhone app.");

test.use({
  viewport: { width: 411, height: 914 },
  // A tone plays without a click first, as a call's voices do in the app,
  // and the stand-in's address is a plain one rather than a `.local` name
  // nothing here would answer for.
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"] },
});

const GOOD = "https://good-company.example";

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The voice frames the phone sent its server, by op. */
async function sent(page: Page, op: string): Promise<string[]> {
  return (await did(page)).filter((line) => line.startsWith(`send ${GOOD}:`) && line.includes(`"op":"${op}"`));
}

/** The phone, in #general, with the server's forwarding standing by, every connection in (#355). */
async function inGeneral(page: Page, extra = "") {
  await page.goto(`/tests/fixtures/next-list-window.html?one&shell=phone&sfu${extra}`);
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

const strip = (page: Page) => page.getByRole("group", { name: "Voice in this conversation" });
const chip = (page: Page, name: string) => strip(page).locator(".k-chip", { hasText: name });
const sfuState = (page: Page) => page.evaluate(() => window.core?.sfu?.state() ?? "none");
const received = (page: Page) => page.evaluate(async () => (await window.core?.sfu?.received()) ?? { packets: 0, level: 0 });

/** Packets the server got from the phone's microphone over `ms`. */
async function packetsOver(page: Page, ms: number): Promise<number> {
  const before = (await received(page)).packets;
  await page.waitForTimeout(ms);
  return (await received(page)).packets - before;
}

async function join(page: Page) {
  await strip(page).getByRole("button", { name: "Join" }).click();
  await expect.poll(() => sfuState(page), { timeout: 10_000 }).toBe("connected");
}

test("joins from the room, answers the server, hears Eli talking and is heard", async ({ page }) => {
  await inGeneral(page);
  await join(page);

  // One join, forwarded, carrying the controls; then the answer to the offer.
  const joins = await sent(page, "voice.join");
  expect(joins).toHaveLength(1);
  expect(joins[0]).toContain('"forwarding":true');
  expect(joins[0]).toContain('"controls":{"muted":false,"deafened":false}');
  expect(await sent(page, "voice.answer")).toHaveLength(1);

  // Eli's tone lights Eli; Jules, in voice and silent, stays dark.
  await expect(chip(page, "Eli")).toHaveAttribute("data-active", "yes", { timeout: 5000 });
  await expect(chip(page, "Jules")).not.toHaveAttribute("data-active", "yes");

  // The phone's microphone reaches the server, and loud.
  await expect.poll(async () => (await received(page)).packets, { timeout: 5000 }).toBeGreaterThan(20);
  await expect.poll(async () => (await received(page)).level, { timeout: 5000 }).toBeGreaterThan(0.05);
});

test("mute tells the room and stops sending, and silence costs next to nothing", async ({ page }) => {
  await inGeneral(page);
  await join(page);
  await expect.poll(() => packetsOver(page, 1000), { timeout: 8000 }).toBeGreaterThan(30);

  await strip(page).getByRole("button", { name: "Mute" }).click();
  await expect.poll(async () => (await sent(page, "voice.join")).some((line) => line.includes('"controls":{"muted":true,"deafened":false}'))).toBe(true);
  // A muted microphone sends silence, and Opus stops sending in silence
  // (`usedtx`): a packet every 400 ms or so, where talking sends fifty a second.
  await expect.poll(() => packetsOver(page, 1000), { timeout: 8000 }).toBeLessThan(10);

  await strip(page).getByRole("button", { name: "Muted" }).click();
  await expect.poll(() => packetsOver(page, 1000), { timeout: 8000 }).toBeGreaterThan(30);
});

test("a quiet microphone sends next to nothing, as the desktop sends nothing", async ({ page }) => {
  await inGeneral(page, "&micquiet");
  await join(page);
  await page.waitForTimeout(1500);
  expect(await packetsOver(page, 2000)).toBeLessThan(15);
});

test("a connection that goes quiet is started afresh, and Eli is heard again", async ({ page }) => {
  test.setTimeout(45_000);
  await inGeneral(page);
  await join(page);
  await expect(chip(page, "Eli")).toHaveAttribute("data-active", "yes", { timeout: 5000 });

  // The network under the call goes: nothing comes back from the server's end.
  await page.evaluate(() => window.core?.sfu?.drop());
  // ICE calls it disconnected, it stays so, and the phone asks for a fresh
  // connection (PROTOCOL, "Voice forwarding"): once, not over and over.
  await expect.poll(async () => (await sent(page, "voice.restart")).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => sfuState(page), { timeout: 10_000 }).toBe("connected");
  expect(await sent(page, "voice.answer")).toHaveLength(2);
  await expect(chip(page, "Eli")).toHaveAttribute("data-active", "yes", { timeout: 5000 });
  await page.waitForTimeout(4000);
  expect(await sent(page, "voice.restart")).toHaveLength(1);
});

test("leaving says so, lets the microphone go, and stops every voice", async ({ page }) => {
  await inGeneral(page);
  await join(page);
  await expect(chip(page, "Eli")).toHaveAttribute("data-active", "yes", { timeout: 5000 });
  expect(await page.locator("audio[data-voice]").count()).toBe(2);

  await strip(page).getByRole("button", { name: "Leave voice" }).click();
  await expect.poll(async () => (await sent(page, "voice.leave")).length).toBe(1);
  await expect(page.locator("audio[data-voice]")).toHaveCount(0);
  await expect.poll(() => sfuState(page)).toBe("none");
  await expect(strip(page).getByRole("button", { name: "Join" })).toBeVisible();
});
