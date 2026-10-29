import { expect, type Page, test } from "@playwright/test";
import type { Message } from "../../src/generated/Message";

// Whatever adds or changes the newest row while you're reading at the bottom,
// it ends up on screen whole and, if it's new, read (#760). #750 got past
// every test: the page's server answered in 20 ms, and the tests looked for a
// message's words, not for them on screen. Here every answer takes as long as
// a real server's (`netms`), a photo comes as slowly, and each case checks the
// newest row top to bottom against the conversation's edges.
//
// The page's evening is weeks ago, so the first thing that arrives opens a new
// day, under "you left off here": three rows at once, as in #750. Sending your
// own message is next-chat-window.spec.ts's #750 test.

test.use({ viewport: { width: 780, height: 820 } });

const SERVER = "https://good-company.example";
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;
/** How long the page's server, and the photos, take to answer. */
const NET_MS = 250;
const TRAIL_URL = "https://millrace-trail.org/river-loop";
const LONG = "Found the old trail map in a drawer, the one with the bridge that washed out, so we'll want the long way round. ".repeat(5);

async function open(page: Page, query = "") {
  await page.route(`${SERVER}/media/**`, async (route) => {
    await new Promise((settle) => setTimeout(settle, NET_MS));
    await route.fulfill({ contentType: "image/svg+xml", body: PHOTO });
  });
  await page.goto(`/tests/fixtures/next-chat-window.html?room=r-general&netms=${NET_MS}${query}`);
  // At the bottom and caught up: the newest is read.
  await expect.poll(() => reads(page), { timeout: 10_000 }).toEqual(["m000016"]);
}

/** The read positions the window has given the list window, oldest first. */
async function reads(page: Page): Promise<string[]> {
  const did = (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
  return did
    .filter((line) => line.startsWith("intent:"))
    .map((line) => JSON.parse(line.slice("intent:".length)) as { kind: string; messageId?: string })
    .flatMap((intent) => (intent.kind === "read" && intent.messageId !== undefined ? [intent.messageId] : []));
}

let made = 0;
/** Somebody else's message arriving over the socket, as the server sends it. */
async function arrives(page: Page, changes: Partial<Message> = {}): Promise<string> {
  made += 1;
  const message: Message = {
    id: `m95${String(made).padStart(4, "0")}`,
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
    ...changes,
  };
  await page.evaluate((d) => window.owner?.frame({ op: "message.create", d }), message);
  return message.id;
}

/**
 * The newest row is on screen from its top to its bottom, and the
 * conversation is at its end, once things settle. A row left short stays
 * short, so this runs out of time and says by how much.
 */
async function expectNewestWhole(page: Page, key: string) {
  const where = () =>
    page.getByRole("log").evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>("[data-index]")];
      const newest = rows.reduce<HTMLElement | null>((last, row) => (last === null || Number(row.dataset.index) > Number(last.dataset.index) ? row : last), null);
      if (newest === null) return "no rows";
      const edges = element.getBoundingClientRect();
      const box = newest.getBoundingClientRect();
      const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (box.top < edges.top - 1 || box.bottom > edges.bottom + 1 || gap > 1)
        return `${newest.dataset.key}: ${Math.round(box.bottom - edges.bottom)} px past the bottom, ${Math.round(gap)} px from the end`;
      return `${newest.dataset.key} whole`;
    });
  await expect.poll(where, { timeout: 3_000 }).toBe(`${key} whole`);
}

/**
 * The newest message has arrived and nothing is moving: it's read, which the
 * window says once following it down has finished, and the conversation has
 * held still for ten frames. Changed while it was still being followed down,
 * a row growing in place was carried to the end with it, and a test passed
 * that would have failed a moment later (#760).
 */
async function settled(page: Page, id: string) {
  await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
  await page.getByRole("log").evaluate(
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

for (const [what, body] of [
  ["a line", "Anyone up for a walk tomorrow?"],
  ["a long message", LONG],
] as const) {
  test(`${what} from somebody else lands whole, and is read`, async ({ page }) => {
    await open(page);
    const id = await arrives(page, { body });
    await expectNewestWhole(page, id);
    await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
  });
}

test("a reply, its quote above it, lands whole, and is read", async ({ page }) => {
  await open(page);
  const id = await arrives(page, { body: "Count me in for that.", reply_to: "m000012" });
  await expectNewestWhole(page, id);
  await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
});

test("three messages at once land whole, and the last is read", async ({ page }) => {
  await open(page);
  await arrives(page, { body: "Morning!", author_id: "u-jules" });
  await arrives(page, { body: LONG, author_id: "u-dave" });
  const id = await arrives(page, { body: "Coffee first.", author_id: "u-eli" });
  await expectNewestWhole(page, id);
  await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
});

for (const [what, size] of [
  ["a photo", { width: 1200, height: 900 }],
  ["a photo from a server that doesn't say its size", { width: null, height: null }],
] as const) {
  test(`${what} lands whole once it has loaded, and is read`, async ({ page }) => {
    await open(page);
    const id = await arrives(page, {
      body: "",
      attachments: [
        {
          id: `a-trail-${made}`,
          filename: "trail.png",
          mime: "image/png",
          size_bytes: 204_800,
          url: `${SERVER}/media/trail-${made}.png`,
          ...size,
          duration_ms: null,
          blurhash: null,
          poster_url: null,
          starred_at: null,
          uploader_id: "u-eli",
          created_at: Date.now(),
        },
      ],
    });
    await expect(page.getByRole("log").locator("img").last()).toHaveJSProperty("complete", true);
    await expectNewestWhole(page, id);
    await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
  });
}

test("a link card landing on the newest message keeps it whole", async ({ page }) => {
  await open(page, "&holdpreviews");
  const id = await arrives(page, { body: `The loop's open again: ${TRAIL_URL}` });
  await expectNewestWhole(page, id);
  await settled(page, id);
  await page.evaluate(() => window.owner?.releasePreviews());
  await expect(page.getByRole("log").getByText("Millrace River Trail").last()).toBeVisible();
  await expectNewestWhole(page, id);
});

test("the newest message edited longer stays whole", async ({ page }) => {
  await open(page);
  const id = await arrives(page);
  await expectNewestWhole(page, id);
  await settled(page, id);
  const edited = await page.evaluate(
    ([id, body]) => {
      const now = Date.now();
      window.owner?.frame({
        op: "message.update",
        d: { id, room_id: "r-general", author_id: "u-eli", body, reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: now, deleted_at: null, created_at: now - 1_000 },
      });
      return id;
    },
    [id, LONG] as const,
  );
  await expect(page.getByRole("log").getByText("Found the old trail map")).toBeVisible();
  await expectNewestWhole(page, edited);
});

test("a reaction on the newest message keeps it whole", async ({ page }) => {
  await open(page);
  const id = await arrives(page);
  await expectNewestWhole(page, id);
  await settled(page, id);
  await page.evaluate((id) => window.owner?.frame({ op: "reaction.update", d: { message_id: id, key: "👍", count: 2, user_ids: ["u-jules", "u-dave"] } }), id);
  await expect(page.locator(".nx-react-pill").last()).toBeVisible();
  await expectNewestWhole(page, id);
});

test("a poll lands whole, and is read", async ({ page }) => {
  await open(page);
  const id = await arrives(page, {
    body: "",
    author_id: "u-matt",
    poll: {
      question: "Which trail on Saturday?",
      choices: [
        { text: "The river loop", voter_ids: [] },
        { text: "Up past the old mill", voter_ids: ["u-jules"] },
        { text: "Whichever has coffee at the end", voter_ids: ["u-eli", "u-dave"] },
      ],
      multi: false,
      closes_at: Date.now() + 86_400_000,
      closed_at: null,
      closed_by: null,
    },
  });
  await expectNewestWhole(page, id);
  await expect.poll(async () => (await reads(page)).at(-1)).toBe(id);
});

for (const [what, changes] of [
  ["somebody joining voice", { body: "", author_id: "u-dave", voice_join: true }],
  ["somebody sharing their screen", { body: "", author_id: "u-jules", screen_share: true }],
] as const) {
  test(`the line saying ${what} lands whole`, async ({ page }) => {
    await open(page);
    const id = await arrives(page, changes);
    await expectNewestWhole(page, id);
  });
}
