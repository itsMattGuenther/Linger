import { expect, type Page, test } from "@playwright/test";

// Reduced motion in the new client (parity NAME-5, LOOK-4): movement goes,
// and what the movement was saying stays. Measured on the kit gallery
// (tests/fixtures/kit.html) and the chat window's page (next-chat.html).

/** Every animation running on the page: how long one round takes, and how many rounds. */
async function animations(page: Page): Promise<{ name: string; duration: number; iterations: number }[]> {
  return page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return {
        name: animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? `transition ${animation.transitionProperty}` : "script",
        duration: Number(timing?.duration ?? 0),
        iterations: Number(timing?.iterations ?? 1),
      };
    }),
  );
}

const PAGES = [
  { what: "the kit gallery", url: "/tests/fixtures/kit.html", size: { width: 1280, height: 900 }, ready: "[data-section]" },
  { what: "a conversation someone is typing in, with voice on", url: "/tests/fixtures/next-chat.html?tab=r-listening&voice=elsewhere", size: { width: 780, height: 790 }, ready: "[data-screen='chat']" },
];

for (const where of PAGES) {
  test(`${where.what}: moves only for people who want it, and keeps saying the same things (LOOK-4)`, async ({ page }) => {
    await page.setViewportSize(where.size);
    await page.goto(where.url);
    await expect(page.locator(where.ready).first()).toBeVisible();
    // With motion: something loops (bars, dots, spinners), or this proves nothing.
    await expect.poll(async () => (await animations(page)).filter((one) => one.iterations === Infinity).length).toBeGreaterThan(0);
    const said = await page.evaluate(() => ({
      speaking: document.querySelectorAll("[data-kit='VoiceGlyph'][data-speaking='yes']").length,
      typing: document.querySelector(".nx-typing")?.textContent ?? "",
      spinners: document.querySelectorAll("[data-kit='Spinner']").length,
    }));

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(where.url);
    await expect(page.locator(where.ready).first()).toBeVisible();
    await page.waitForTimeout(100);
    const moving = (await animations(page)).filter((one) => one.iterations === Infinity || one.duration > 1);
    expect(moving).toEqual([]);
    // Still saying it: who's talking, who's typing, what's busy.
    expect(
      await page.evaluate(() => ({
        speaking: document.querySelectorAll("[data-kit='VoiceGlyph'][data-speaking='yes']").length,
        typing: document.querySelector(".nx-typing")?.textContent ?? "",
        spinners: document.querySelectorAll("[data-kit='Spinner']").length,
      })),
    ).toEqual(said);
  });
}

test("a name's shimmer and glow stop under reduced motion, and the name keeps its colors (NAME-5)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const look = () =>
    page.evaluate(() => {
      const shimmer = document.querySelector(".name[data-name-effect='shimmer']");
      const glow = document.querySelector(".name[data-name-effect='glow']");
      if (!shimmer || !glow) return null;
      const s = getComputedStyle(shimmer);
      const g = getComputedStyle(glow);
      return { shimmer: s.animationName, shimmerPaint: s.backgroundImage, glow: g.textShadow, glowColor: g.color };
    });
  await page.goto("/tests/fixtures/kit.html");
  await expect(page.locator("[data-section]").first()).toBeVisible();
  const moving = await look();
  expect(moving).not.toBeNull();
  expect(moving?.shimmer).toBe("k-name-shimmer");
  expect(moving?.glow).not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/kit.html");
  await expect(page.locator("[data-section]").first()).toBeVisible();
  const still = await look();
  expect(still?.shimmer).toBe("none");
  expect(still?.glow).toBe("none");
  // The paint is still theirs: only the moving highlight went.
  expect(still?.shimmerPaint).not.toBe("none");
  expect(still?.glowColor).toBe(moving?.glowColor);
});
