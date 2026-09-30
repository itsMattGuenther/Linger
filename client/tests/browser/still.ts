import { expect, type Locator } from "@playwright/test";

/**
 * Wait until something is where it was a moment ago. Playwright waits two
 * animation frames before a click, but a conversation can still be moving a
 * moment later (a link card loading above, a new message scrolling into
 * place), and a click aimed at where a name was lands beside it (#331, #361).
 */
export async function still(target: Locator, every = 100) {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await target.boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [every] },
    )
    .toBe(true);
}
