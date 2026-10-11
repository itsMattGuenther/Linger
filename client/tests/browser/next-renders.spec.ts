import { expect, type Page, test } from "@playwright/test";

// How much of the list window React draws again for one event (#533), in the
// real list window (tests/fixtures/next-list-window.tsx) with #general open
// beside it. Every event on every server used to draw the whole list and
// every message row in the open conversation again: 237 components for one
// person's presence changing on another server, and 544, every message row
// twice, for one message in the open room.
//
// The count comes from React itself. Before the page loads, a stand-in for
// React's developer-tools hook is put on the window; React hands it every
// commit, and it walks the tree the way the developer tools do, counting the
// components that really ran (React marks them) and skipping what React
// didn't touch. Development builds only, which is what the page server serves.

test.use({ viewport: { width: 1120, height: 820 } });

const HOME = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";

interface Drawn {
  total: number;
  byName: Record<string, number>;
}

declare global {
  interface Window {
    /** Components React ran since the count was last reset, by name. */
    renders?: Drawn;
  }
}

/** Installs the stand-in hook. Runs before any of the page's own scripts. */
function countRenders() {
  // React's tags for components that run code: function, class, forwardRef, memo, simple memo.
  const COMPONENTS = new Set([0, 1, 11, 14, 15]);
  // React's mark on a component that ran in this render.
  const PERFORMED_WORK = 1;
  type Fiber = { tag: number; flags: number; type: unknown; elementType: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  window.renders = { total: 0, byName: {} };
  const named = (value: unknown): string | null => {
    if (typeof value === "function") return (value as { displayName?: string }).displayName ?? value.name;
    if (typeof value === "object" && value !== null) {
      const inner = value as { displayName?: string; type?: unknown; render?: unknown };
      return inner.displayName ?? named(inner.type) ?? named(inner.render);
    }
    return null;
  };
  const count = (fiber: Fiber) => {
    const drawn = (window.renders ??= { total: 0, byName: {} });
    const name = named(fiber.elementType) ?? named(fiber.type) ?? "?";
    drawn.total += 1;
    drawn.byName[name] = (drawn.byName[name] ?? 0) + 1;
  };
  const mounted = (fiber: Fiber) => {
    const stack = [fiber];
    for (let next = stack.pop(); next; next = stack.pop()) {
      if (COMPONENTS.has(next.tag)) count(next);
      for (let child = next.child; child; child = child.sibling) stack.push(child);
    }
  };
  const updated = (next: Fiber, prev: Fiber) => {
    if (COMPONENTS.has(next.tag) && (next.flags & PERFORMED_WORK) !== 0) count(next);
    // Children React didn't touch are the very same objects as last time.
    if (next.child === prev.child) return;
    for (let child = next.child; child; child = child.sibling) {
      if (child.alternate) updated(child, child.alternate);
      else mounted(child);
    }
  };
  let ids = 0;
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    value: {
      renderers: new Map(),
      supportsFiber: true,
      isDisabled: false,
      inject() {
        ids += 1;
        return ids;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        const current = root.current;
        if (current.alternate) updated(current, current.alternate);
        else mounted(current);
      },
    },
  });
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/**
 * The list window, with every connection's `ready` in. In development React
 * starts the list twice, so each server is connected twice (#355).
 */
async function open(page: Page, query = "") {
  await page.addInitScript(countRenders);
  await page.clock.install();
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
}

/** #general beside the list, its evening drawn. */
async function generalBeside(page: Page) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

/** Wait until React has drawn nothing for half a second. */
async function still(page: Page) {
  let last = -1;
  for (;;) {
    const now = await page.evaluate(() => window.renders?.total ?? 0);
    if (now === last) return;
    last = now;
    await page.waitForTimeout(500);
  }
}

/**
 * What React drew for `act`, once it has finished drawing. The page's clock
 * is held still meanwhile: the once-a-minute clock landing in the middle
 * would draw every time on screen again for a reason of its own.
 */
async function drawnFor(page: Page, act: () => Promise<unknown>): Promise<Drawn> {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  // Whatever jumping that second asked React to draw, it has drawn.
  await still(page);
  await page.evaluate(() => {
    window.renders = { total: 0, byName: {} };
  });
  await act();
  await still(page);
  const drawn = await page.evaluate(() => window.renders ?? { total: 0, byName: {} });
  await page.clock.resume();
  return drawn;
}

const frame = (page: Page, server: string, op: string, d: unknown) =>
  page.evaluate(([where, op_, d_]) => window.core?.frame(where, { op: op_, d: d_ } as never), [server, op, d] as const);

const said = (id: string, room: string, author: string, body: string) => ({
  id,
  room_id: room,
  author_id: author,
  body,
  reply_to: null,
  attachments: [],
  reactions: [],
  pinned_at: null,
  edited_at: null,
  deleted_at: null,
  created_at: Date.now(),
});

/** How many of these components were drawn. A memoized one is named with a 2 after it. */
const of = (drawn: Drawn, ...names: string[]) => names.reduce((sum, name) => sum + (drawn.byName[name] ?? 0) + (drawn.byName[`${name}2`] ?? 0), 0);

test("somebody's presence changing on another server draws that server's section only: no message, no row, no other server (#533)", async ({ page }) => {
  await open(page);
  await generalBeside(page);
  const drawn = await drawnFor(page, () => frame(page, GUILD, "presence.update", { user_id: "a-pip", state: "away", room_id: null, away_message: "brb" }));
  const seen = JSON.stringify(drawn);
  expect(of(drawn, "ServerSection"), seen).toBe(1);
  expect(of(drawn, "RowView", "SidePane", "PersonItem", "RoomItem"), seen).toBe(0);
  // 237 before #533.
  expect(drawn.total, seen).toBeLessThan(50);
});

test("a message in the open room draws its own row, not every row on screen (#533)", async ({ page }) => {
  await open(page);
  await generalBeside(page);
  const drawn = await drawnFor(page, () => frame(page, HOME, "message.create", said("m900001", "r-general", "u-eli", "Here now.")));
  await expect(page.getByRole("log")).toContainText("Here now.");
  const seen = JSON.stringify(drawn);
  // Every row on screen, twice, before #533: 88.
  expect(of(drawn, "RowView"), seen).toBeLessThanOrEqual(8);
  expect(of(drawn, "MessageRow"), seen).toBe(1);
  // 544 before #533.
  expect(drawn.total, seen).toBeLessThan(250);
});

test("somebody's presence changing on the open conversation's server draws their row, and no message (#533)", async ({ page }) => {
  await open(page);
  await generalBeside(page);
  const drawn = await drawnFor(page, () => frame(page, HOME, "presence.update", { user_id: "u-dave", state: "away", room_id: null, away_message: "dinner" }));
  const seen = JSON.stringify(drawn);
  expect(of(drawn, "RowView"), seen).toBe(0);
  expect(of(drawn, "PersonItem"), seen).toBe(1);
  expect(drawn.total, seen).toBeLessThan(150);
});

test("thirty servers starting together all draw, with no complaint from React about too many updates (#512)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await open(page, "?servers=30");
  await expect(page.locator("section.nx-srv")).toHaveCount(30);
  await still(page);
  expect(errors.filter((error) => /Maximum update depth/.test(error))).toEqual([]);
});
