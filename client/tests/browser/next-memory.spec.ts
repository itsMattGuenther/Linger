import { type CDPSession, expect, type Page, test } from "@playwright/test";

// What the list window holds on to over a long evening (#534), counted with
// Chromium's own tools. Switching conversations used to leave every old
// drawing of the conversation behind, each holding the one before it, about
// 6 KB a switch, for as long as the window was open. People leave Linger
// running for days.

test.use({ viewport: { width: 1120, height: 820 } });

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/**
 * Every function alive in the page once everything that can be let go of is
 * gone, by name. Drawing a component makes functions, and a drawing that's
 * been let go of takes them with it, so the count says how many old drawings
 * are still held, and their names say whose. Counted rather than weighed:
 * the page's memory goes up and down by half a megabyte between two
 * measurements of the same page, which buries a leak of a few kilobytes a
 * switch. The count comes out the same every run.
 */
async function living(cdp: CDPSession): Promise<Record<string, number>> {
  for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
  const { result: prototype } = await cdp.send("Runtime.evaluate", { expression: "Function.prototype", objectGroup: "count" });
  if (!prototype.objectId) throw new Error("no Function.prototype");
  const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: prototype.objectId, objectGroup: "count" });
  if (!objects.objectId) throw new Error("no functions found");
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: objects.objectId,
    functionDeclaration:
      "function () { const named = {}; for (const one of this) { const name = one.name || '?'; named[name] = (named[name] || 0) + 1; } return JSON.stringify(named); }",
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "count" });
  return JSON.parse(String(result.value)) as Record<string, number>;
}

/** How many more of each there are, the most first: what a leak is made of. */
function grown(before: Record<string, number>, after: Record<string, number>): [string, number][] {
  return Object.entries(after)
    .map(([name, count]): [string, number] => [name, count - (before[name] ?? 0)])
    .filter(([, more]) => more > 0)
    .sort((a, b) => b[1] - a[1]);
}

test("switching between rooms beside the list over and over leaves no old drawings behind (#534)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "counted with Chromium's own tools");
  // Long by design: 150 switches (testing-strategy.md, #328).
  test.slow();
  const cdp = await page.context().newCDPSession(page);
  await page.goto("/tests/fixtures/next-list-window.html");
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);

  // Each switch is a click on a room in the list, and the room drawn beside
  // it, landed on, and a moment to read it, as somebody clicking through
  // would. Done in the page itself: a hundred and fifty of them through the
  // test's own tools would take minutes.
  const switchRooms = (times: number) =>
    page.evaluate(async (count) => {
      const rooms = ["general", "listening-room", "weekend-plans"];
      const frame = () => new Promise((settle) => requestAnimationFrame(settle));
      for (let at = 0; at < count; at += 1) {
        const name = rooms[at % rooms.length] ?? "general";
        const list = document.querySelector('ul[aria-label^="Rooms"]');
        const row = [...(list?.querySelectorAll<HTMLButtonElement>("button.k-row-main") ?? [])].find((button) =>
          new RegExp(`^#${name}\\b`).test(button.getAttribute("aria-label") ?? ""),
        );
        if (!row) throw new Error(`no row for #${name}`);
        row.click();
        for (let waited = 0; ; waited += 1) {
          const log = document.querySelector('[role="log"]');
          if (log?.getAttribute("aria-label") === `Messages in #${name}` && log.querySelector(".nx-conv-row") && log.getAttribute("aria-busy") !== "true") break;
          if (waited > 600) throw new Error(`#${name} never drew`);
          await frame();
        }
        await new Promise((settle) => setTimeout(settle, 40));
      }
    }, times);

  // Every room opened and drawn a few times first: what's kept on purpose
  // (each room's history, the code itself) is in by then.
  await switchRooms(30);
  const before = await living(cdp);
  await switchRooms(120);
  const more = grown(before, await living(cdp));
  const total = more.reduce((sum, [, count]) => sum + count, 0);
  // Before #534, 120 switches left about 3,700 more functions alive, among
  // them two a switch from the conversation (`messageFromCard`) and one from
  // the list (`changePrefs`): a chain of old drawings, each holding the one
  // before. After it, about 700, the same every run.
  expect(total, `more functions alive after 120 switches, the most first: ${JSON.stringify(more.slice(0, 12))}`).toBeLessThan(1_500);
});
