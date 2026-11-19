import { expect, type Page, test } from "@playwright/test";
import type { Message } from "../../src/generated/Message";

// Back to the newest (#945, SPEC §4.2). Read more than three screens up from
// the newest message, with the newest still held, and the conversation's
// button shows: the same one as out of a historical window, in the same
// place. Pressed, it lands on the newest, the way a caught-up conversation
// opens, from what's held, and the newest is read there as usual. Within a
// screen of the bottom it goes; once shown, it stays until then, so it
// doesn't come and go at one line. It goes by distance alone, so a room that
// opens on "you left off here" far up offers it straight away. Out of a
// historical window (#173) it's as it was: next-chat-parity.spec.ts,
// "reading far back".
//
// The distance is the conversation's: rows it hasn't drawn yet count at
// their estimate, so the tests read it from the page and steer by it. Its
// way somewhere (landing, a jump, following new messages down) isn't where
// the reader is, so the button never shows on the way.

test.use({ viewport: { width: 780, height: 820 } });

const log = (page: Page) => page.getByRole("log");
const newest = (page: Page) => page.getByRole("button", { name: "Back to the newest" });

/** Everything the page asked of the shell, the owner and the server, in order. */
async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The read positions the window gave the list window, oldest first. */
async function reads(page: Page): Promise<string[]> {
  return (await did(page))
    .filter((line) => line.startsWith("intent:"))
    .map((line) => JSON.parse(line.slice("intent:".length)) as { kind: string; messageId?: string })
    .flatMap((intent) => (intent.kind === "read" && intent.messageId !== undefined ? [intent.messageId] : []));
}

/** #general in a window of its own, with 600 older messages behind the evening, landed on the newest. */
async function openWindow(page: Page) {
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&many=600");
  await landed(page, "m000016");
  await expect.poll(() => reads(page)).toEqual(["m000016"]);
}

/** In the list window (`?shell=phone` for the phone), #general opened from the list and landed on the newest. */
async function openFromList(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  // Each connection has had its `ready`: a room opened between two would sit empty (#355).
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await landed(page, "m000016");
}

/** The conversation has landed (it's busy until then), on `key`, and holds still. */
async function landed(page: Page, key: string) {
  await expect(log(page)).toBeVisible();
  await expect(log(page)).not.toHaveAttribute("aria-busy", "true");
  await expectNewestWhole(page, key);
  await settled(page);
}

/** Nothing has moved the conversation for ten frames: what it asked for is in, and measured. */
async function settled(page: Page) {
  await log(page).evaluate(
    (element) =>
      new Promise<void>((done) => {
        let last = -1;
        let same = 0;
        const frame = () => {
          const now = element.scrollTop + element.scrollHeight * 100_000;
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= 10) done();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/** How far the bottom of the screen is above the end of the conversation, in screens of it. */
function screensUp(page: Page): Promise<number> {
  return log(page).evaluate((element) => (element.scrollHeight - element.scrollTop - element.clientHeight) / element.clientHeight);
}

/**
 * Scrolled to `screens` above the end, give or take a tenth. Rows coming
 * into view are measured as they're drawn and move the end by however much
 * their estimate was out, so it aims again until it's there.
 */
async function upBy(page: Page, screens: number) {
  await expect
    .poll(async () => {
      await log(page).evaluate((element, to) => {
        element.scrollTop = element.scrollHeight - element.clientHeight * (1 + to);
      }, screens);
      await settled(page);
      return Math.abs((await screensUp(page)) - screens) < 0.1;
    })
    .toBe(true);
}

/**
 * From the page's start, `html[data-newest-showed]` says whether Back to the
 * newest has been drawn, even for a frame, over messages. Before any are
 * drawn, a room opening around where you left off is a window that doesn't
 * hold the newest yet, and shows it for that moment, as it did before #945.
 */
async function watchButton(page: Page) {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector(".nx-conv-newest") && document.querySelector(".nx-conv-row")) document.documentElement.dataset.newestShowed = "yes";
    }).observe(document, { childList: true, subtree: true });
  });
}
const showed = (page: Page) => page.evaluate(() => document.documentElement.dataset.newestShowed === "yes");
const forget = (page: Page) => page.evaluate(() => delete document.documentElement.dataset.newestShowed);

/**
 * The newest row is on screen from its top to its bottom, and the
 * conversation is at its end.
 */
async function expectNewestWhole(page: Page, key: string) {
  const where = () =>
    log(page).evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>("[data-index]")];
      const last = rows.reduce<HTMLElement | null>((was, row) => (was === null || Number(row.dataset.index) > Number(was.dataset.index) ? row : was), null);
      if (last === null) return "no rows";
      const edges = element.getBoundingClientRect();
      const box = last.getBoundingClientRect();
      const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (box.top < edges.top - 1 || box.bottom > edges.bottom + 1 || gap > 1)
        return `${last.dataset.key}: ${Math.round(box.bottom - edges.bottom)} px past the bottom, ${Math.round(gap)} px from the end`;
      return `${last.dataset.key} whole`;
    });
  await expect.poll(where, { timeout: 5_000 }).toBe(`${key} whole`);
}

/** How opaque an element's own background is, from 0 to 255. Runs in the page. */
function opacity(node: Element): number {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) throw new Error("no canvas");
  context.fillStyle = getComputedStyle(node).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
}

/** Somebody else's message arriving over the socket, as the server sends it: the `nth` this test sends. */
async function arrives(page: Page, nth = 1): Promise<string> {
  const message: Message = {
    id: `m945${String(nth).padStart(4, "0")}`,
    room_id: "r-general",
    author_id: "u-eli",
    body: "Anyone up for a walk tomorrow?",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: Date.now(),
  };
  await page.evaluate((d) => window.owner?.frame({ op: "message.create", d }), message);
  return message.id;
}

test("well up from the newest it shows; pressed, it lands on the newest from what's held, and that's read", async ({ page }) => {
  await openWindow(page);
  await expect(newest(page)).toHaveCount(0);
  await upBy(page, 3.5);
  await expect(newest(page)).toBeVisible();

  // Something new arrives below the reader: it doesn't move them, and isn't read.
  const id = await arrives(page);
  await expect(log(page).locator(`[data-key="${id}"]`)).toHaveCount(0);
  await settled(page);
  expect(await reads(page)).not.toContain(id);
  const asked = (await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages")).length;

  // Pressed, it's gone by the next frame, not once the conversation has got there.
  const lingered = await newest(page).evaluate(
    (button) =>
      new Promise<boolean>((done) => {
        (button as HTMLButtonElement).click();
        requestAnimationFrame(() => done(document.querySelector(".nx-conv-newest") !== null));
      }),
  );
  expect(lingered).toBe(false);
  await expectNewestWhole(page, id);
  await expect(newest(page)).toHaveCount(0);
  await expect(log(page)).not.toHaveAttribute("aria-busy", "true");
  // Read, as at the bottom of any conversation.
  await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
  // From what's held: nothing asked of the server. Out of a historical window
  // the room opens at its newest again instead (#173).
  await settled(page);
  expect((await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages")).length).toBe(asked);

  // And the conversation is its usual self after: up at the top, older history loads.
  const older = async () => (await did(page)).filter((line) => line.startsWith("GET /rooms/r-general/messages?limit=100&before=")).length;
  const before = await older();
  await expect
    .poll(async () => {
      await log(page).evaluate((element) => {
        element.scrollTop = 0;
      });
      return older();
    })
    .toBeGreaterThan(before);
});

test("messages arriving below put nothing up by themselves; the reader's next scroll does, once they're more than three screens up", async ({ page }) => {
  await watchButton(page);
  await openWindow(page);
  await upBy(page, 2.5);
  // More than a screen of them: the reader is more than three screens above
  // the newest now, without having moved. What's new isn't a reason to
  // show it (SPEC §4.2).
  for (let nth = 1; nth <= 40; nth += 1) await arrives(page, nth);
  await settled(page);
  expect(await screensUp(page)).toBeGreaterThan(3);
  expect(await showed(page)).toBe(false);
  // The reader scrolls, a little: now it's where they are that counts.
  await log(page).evaluate((element) => element.scrollBy({ top: -10 }));
  await expect(newest(page)).toBeVisible();
});

test("the conversation getting shorter moves the line: two and a half screens up in a tall one is well up in a short one", async ({ page }) => {
  await openWindow(page);
  await upBy(page, 2.5);
  await expect(newest(page)).toHaveCount(0);
  await page.setViewportSize({ width: 780, height: 520 });
  await expect.poll(() => screensUp(page)).toBeGreaterThan(3);
  await expect(newest(page)).toBeVisible();
});

test("pressed from the keyboard, the conversation keeps the focus, not the page", async ({ page }) => {
  await openWindow(page);
  await upBy(page, 3.5);
  await newest(page).focus();
  await page.keyboard.press("Enter");
  await expectNewestWhole(page, "m000016");
  await expect(newest(page)).toHaveCount(0);
  await expect(log(page)).toBeFocused();
});

test("pressed with the mouse, it leaves the cursor in the message box, so typing carries on there", async ({ page }) => {
  await openWindow(page);
  const box = page.getByRole("combobox", { name: /^Message/ });
  await box.click();
  await upBy(page, 3.5);
  await expect(box).toBeFocused();
  await newest(page).click();
  await expectNewestWhole(page, "m000016");
  // The button has gone: had it taken the cursor, the cursor would have gone with it.
  await expect(newest(page)).toHaveCount(0);
  await expect(box).toBeFocused();
  await page.keyboard.type("on my way");
  await expect(box).toHaveValue("on my way");
});

test("at the bottom, more than three screens of messages arriving at once, each taller than its guess, are followed down, and it never shows", async ({ page }) => {
  await watchButton(page);
  await openWindow(page);
  // A little short of the very end, which still counts as at it: the
  // conversation follows down itself, a frame or more after they arrive.
  await log(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 30;
  });
  await settled(page);
  // All in one go, as a reconnect's replay can bring them: the follow
  // carries the reader down, and the way down isn't somewhere they read.
  // Five lines each, where a row is guessed at one until it's drawn, so on
  // the way down the end is further than it was aimed at.
  await page.evaluate(() => {
    for (let nth = 1; nth <= 60; nth += 1) {
      window.owner?.frame({
        op: "message.create",
        d: {
          id: `m946${String(nth).padStart(4, "0")}`,
          room_id: "r-general",
          author_id: "u-eli",
          body: `and another ${nth}\nsecond line\nthird line\nfourth line\nfifth line`,
          reply_to: null,
          attachments: [],
          reactions: [],
          pinned_at: null,
          edited_at: null,
          deleted_at: null,
          created_at: Date.now(),
        },
      });
    }
  });
  await expectNewestWhole(page, "m9460060");
  await settled(page);
  expect(await showed(page)).toBe(false);
});

test("a search hit jumped to under three screens up doesn't show it; one well up shows it once the jump is there", async ({ page }) => {
  await watchButton(page);
  await openWindow(page);
  /** Jumped to and marked, and the mark gone again: it outlasts the jump's aiming. */
  const jump = async (id: string) => {
    const row = page.locator(`[data-message="${id}"]`);
    await page.evaluate((target) => window.owner?.open("r-general", undefined, target), id);
    await expect(row).toHaveAttribute("data-flash", "yes");
    await expect(row).not.toHaveAttribute("data-flash", "yes");
  };
  await jump("l0000588");
  expect(await screensUp(page)).toBeLessThan(3);
  expect(await showed(page)).toBe(false);
  // Further up: the jump scrolls the conversation with no hand on it, and
  // where it ends up is judged.
  await jump("l0000560");
  expect(await screensUp(page)).toBeGreaterThan(3);
  await expect(newest(page)).toBeVisible();
});

test("pressed while a jump to a message further up is on its way, it lands on the newest and stays", async ({ page }) => {
  await openWindow(page);
  await upBy(page, 3.5);
  await expect(newest(page)).toBeVisible();
  // A search hit further up, in what's held: jumped to, which takes a third
  // of a second at least, aiming every frame.
  await page.evaluate(() => window.owner?.open("r-general", undefined, "l0000520"));
  // Under way: the message it's going to is marked as it starts.
  await expect(page.locator('[data-message="l0000520"]')).toHaveAttribute("data-flash", "yes");
  await newest(page).click();
  await expectNewestWhole(page, "m000016");
  // The jump gave way: nothing pulls the view back up once it has stopped.
  await settled(page);
  await expectNewestWhole(page, "m000016");
  await expect(newest(page)).toHaveCount(0);
});

test("a little way up it doesn't show, and once shown it stays until you're within a screen of the bottom", async ({ page }) => {
  await watchButton(page);
  await openWindow(page);
  // Not while it landed, and two screens up is reading, not far.
  await upBy(page, 2);
  await settled(page);
  expect(await showed(page)).toBe(false);

  await upBy(page, 3.5);
  await expect(newest(page)).toBeVisible();
  // Coming back down, it stays past the line it came at...
  await upBy(page, 2);
  await expect(newest(page)).toBeVisible();
  // ...until within a screen of the bottom.
  await upBy(page, 0.5);
  await expect(newest(page)).toHaveCount(0);
  // And going up again, it's three screens again, not two.
  await forget(page);
  await upBy(page, 2);
  await settled(page);
  expect(await showed(page)).toBe(false);
});

test("opened on where you left off, under three screens up, it doesn't show, not even while it lands", async ({ page }) => {
  await watchButton(page);
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&many=600&readto=l0000590");
  await expect(log(page)).not.toHaveAttribute("aria-busy", "true");
  await expect(log(page).getByText("you left off here")).toBeInViewport();
  await settled(page);
  const up = await screensUp(page);
  expect(up).toBeGreaterThan(1);
  expect(up).toBeLessThan(3);
  expect(await showed(page)).toBe(false);
});

test("opened on where you left off, more than three screens up, it shows straight away, and lands on the newest, not the line", async ({ page }) => {
  // A shorter window, so the 46 messages after the line are more than three screens of it.
  await page.setViewportSize({ width: 780, height: 640 });
  await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&many=600&readto=l0000570");
  await expect(log(page)).not.toHaveAttribute("aria-busy", "true");
  const line = log(page).getByText("you left off here");
  await expect(line).toBeInViewport();
  await settled(page);
  // It goes by how far up you are, never by what's new (SPEC §4.2).
  expect(await screensUp(page)).toBeGreaterThan(3);
  await expect(newest(page)).toBeVisible();
  expect(await did(page)).toContain("GET /rooms/r-general/messages?around=l0000570&limit=100 as token-1");

  await newest(page).click();
  await expectNewestWhole(page, "m000016");
  await expect(newest(page)).toHaveCount(0);
  await expect(line).not.toBeInViewport();
  await expect.poll(async () => (await reads(page)).at(-1)).toBe("m000016");
  // The window around the line reached the newest, so it was held: the
  // room wasn't opened at its newest page again.
  expect(await did(page)).not.toContain("GET /rooms/r-general/messages?limit=100 as token-1");
});

/** What an iPhone's web view says it is: the conversation and the virtualizer take its path by it (next-phone-glide.spec.ts). */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

for (const [where, query, size, userAgent] of [
  ["on the phone", "?one&many=600&shell=phone", { width: 390, height: 844 }, undefined],
  ["on an iPhone", "?one&many=600&shell=phone", { width: 390, height: 844 }, IPHONE],
  ["docked beside the list", "?one&many=600", { width: 1120, height: 820 }, undefined],
] as const) {
  test.describe(where, () => {
    test.use({ viewport: size, ...(userAgent ? { userAgent } : {}) });
    test("it shows well up, centered above the message box, and lands on the newest", async ({ page }) => {
      await openFromList(page, query);
      await expect(newest(page)).toHaveCount(0);
      await upBy(page, 3.5);
      await expect(newest(page)).toBeVisible();
      // Centered on the conversation, inside it, and above the message box.
      const button = await newest(page).boundingBox();
      const conversation = await log(page).boundingBox();
      const box = await page.locator(".nx-composer").boundingBox();
      if (!button || !conversation || !box) throw new Error("not on screen");
      expect(Math.abs(button.x + button.width / 2 - (conversation.x + conversation.width / 2))).toBeLessThanOrEqual(1);
      expect(button.y).toBeGreaterThanOrEqual(conversation.y);
      expect(button.y + button.height).toBeLessThanOrEqual(conversation.y + conversation.height);
      expect(button.y + button.height).toBeLessThanOrEqual(box.y);
      // And hides what's under it: the button's own fill is all but
      // see-through, and the words of the messages under it showed through.
      expect(await page.locator(".nx-conv-newest").evaluate(opacity)).toBe(255);

      await newest(page).click();
      await expectNewestWhole(page, "m000016");
      await expect(newest(page)).toHaveCount(0);
    });
  });
}
