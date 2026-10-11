import { expect, type Locator, type Page, test } from "@playwright/test";
import type { User } from "../../src/generated/User";
import { people } from "../fixtures/next/evening";

// The Shimmer name effect (SPEC §4.5), without the cost (#532). Its band was
// a second background moved by `background-position`, which no engine can
// move by itself: every member's app restyled and repainted a shimmering
// name 60 times a second, wherever it showed, for as long as it showed. Now
// a window slides across the name by `transform`, holding a copy of the
// letters slid back by the same amount (kit/Name.css): the compositor moves
// it, and the page does nothing per frame. These hold that, and that the
// copy is there only for the eye: it lies on the letters exactly, and is
// never selected, copied or read out.

const HOME = "https://good-company.example";

/** A gateway frame restyling somebody, as the server sends it. */
const restyle = (page: Page, user: User) => page.evaluate(([server, d]) => window.core?.frame(server, { op: "user.update", d } as never), [HOME, user] as const);

const shimmering = (page: Page) => page.locator(".name[data-name-effect='shimmer']:not([data-dim])");

/** What moves on each shimmering name: its own animations, and every part's under it. */
const motion = (names: Locator) =>
  names.evaluateAll((nodes) =>
    nodes.map((node) => ({
      who: node.textContent,
      own: node.getAnimations().length,
      parts: node.getAnimations({ subtree: true }).map((running) => {
        const effect = running.effect;
        const keyframes = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
        const timing = effect?.getComputedTiming();
        return {
          name: running instanceof CSSAnimation ? running.animationName : "script",
          // What the keyframes change, leaving out their timing.
          moves: [...new Set(keyframes.flatMap((frame) => Object.keys(frame)))].filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key)),
          start: running.startTime,
          length: Number(timing?.duration ?? 0),
          rounds: Number(timing?.iterations ?? 1),
        };
      }),
    })),
  );

test("a shimmering name moves only by transform, so the page does nothing per frame (#532)", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 340, height: 820 });
  await page.goto("/tests/fixtures/next-list-window.html?one");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  // You at the top of the list (display size), and two friends' rows.
  const look = { fill: { kind: "gradient", from: "violet", to: "sky" }, effect: "shimmer" } as const;
  for (const user of [people.matt, people.jules, people.dave]) await restyle(page, { ...user, style: { ...user.style, ...look } });
  await expect(shimmering(page)).toHaveCount(3);

  // Running, in step: each name's window and its copy, started together,
  // forever, 4 seconds a round, changing nothing but where they are.
  await expect
    .poll(async () => (await motion(shimmering(page))).every((name) => name.parts.every((part) => part.start !== null)))
    .toBe(true);
  for (const name of await motion(shimmering(page))) {
    expect(name.own, `${name.who}'s name itself animates nothing`).toBe(0);
    expect(name.parts.map((part) => part.name).sort(), `${name.who}`).toEqual(["k-name-band", "k-name-band-letters"]);
    for (const part of name.parts) {
      expect(part.moves, `${name.who}'s ${part.name}`).toEqual(["transform"]);
      expect(part.length).toBe(4000);
      expect(part.rounds).toBe(Infinity);
      expect(part.start, `${name.who}'s window and copy started together`).toBe(name.parts[0]?.start);
    }
  }

  // And the page's own work, in Chromium (WebView2's engine): a name the
  // page repaints restyles about 60 times a second; one the compositor
  // moves, not at all. Nothing else on this list moves.
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const count = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return metrics.find((metric) => metric.name === "RecalcStyleCount")?.value ?? 0;
    };
    // Once the restyles above have landed and been drawn.
    await page.waitForTimeout(500);
    const before = await count();
    await page.waitForTimeout(1000);
    expect((await count()) - before, "style recalculations in a second").toBeLessThan(15);
  }
});

interface Box {
  who: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Two pictures of the same area compared inside each box: how many pixels
 * hold letters in either, and how many of those the two disagree on by more
 * than a softened edge would. Decoded and counted by the page's own canvas.
 */
function compare(page: Page, area: { x: number; y: number }, boxes: Box[], one: Buffer, other: Buffer) {
  return page.evaluate(
    async ({ area, boxes, pictures }) => {
      const [a, b] = await Promise.all(
        pictures.map(async (b64) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no canvas");
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        }),
      );
      if (!a || !b) throw new Error("no pictures");
      const scale = window.devicePixelRatio;
      return boxes.map((box) => {
        let ink = 0;
        let off = 0;
        for (let y = Math.floor((box.y - area.y) * scale); y < Math.ceil((box.y - area.y + box.h) * scale); y += 1)
          for (let x = Math.floor((box.x - area.x) * scale); x < Math.ceil((box.x - area.x + box.w) * scale); x += 1) {
            const i = (y * a.width + x) * 4;
            const [p, q] = [a.data[i] ?? 0, b.data[i] ?? 0];
            if (p > 128 || q > 128) ink += 1;
            // A copy half a pixel out lights the letters' edges on one
            // side and not the other: whole pixels well off, all along them.
            if (Math.abs(p - q) > 96) off += 1;
          }
        return { who: box.who, ink, off };
      });
    },
    { area, boxes, pictures: [one.toString("base64"), other.toString("base64")] },
  );
}

for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: scale });

    test("a shimmering name's copy of its letters lies on them, in every face and size, cut short or in a sentence (#532)", async ({ page }) => {
      await page.goto("/tests/fixtures/kit.html?shimmer");
      await page.evaluate(() => document.fonts.ready);
      const section = page.locator("[data-section='names']");
      await section.scrollIntoViewIfNeeded();
      const names = section.locator(".name[data-name-effect='shimmer']:not([data-dim])");
      // Every face in a row, the display, body, control and meta sizes, a
      // long name cut short with "…", and three names inside a sentence.
      await expect(names).toHaveCount(12 + 5 + 3);
      const area = await section.boundingBox();
      if (!area) throw new Error("no names to shoot");
      const boxes: Box[] = await names.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { who: `${node.textContent} (${(node as HTMLElement).dataset.size ?? "name"})`, x: box.x, y: box.y, w: box.width, h: box.height };
        }),
      );

      // The band held still over the whole name and unmasked, so the copy
      // shows whole; then the name's letters alone in white, and the copy's
      // alone in white.
      await page.addStyleTag({
        content: `.k-name-band, .k-name-band::before { animation: none !important; transform: none !important; } .k-name-band { mask-image: none !important; clip-path: none !important; }`,
      });
      const letters = await page.addStyleTag({
        content: `.name { background-image: linear-gradient(white, white) !important; } .k-name-band-place { visibility: hidden !important; }`,
      });
      const drawn = await section.screenshot({ animations: "disabled" });
      await letters.evaluate((node: Element) => node.remove());
      await page.addStyleTag({
        content: `.name { background-image: none !important; } .k-name-band::before { color: white !important; -webkit-text-fill-color: white !important; }`,
      });
      const copy = await section.screenshot({ animations: "disabled" });

      for (const { who, ink, off } of await compare(page, area, boxes, drawn, copy)) {
        expect(ink, `${who}: letters to compare`).toBeGreaterThan(20);
        expect(off / ink, `${who}: pixels where the copy and the letters part`).toBeLessThan(0.02);
      }
    });
  });
}

test("a shimmering name's copy is never selected, copied or read out (#532)", async ({ page }) => {
  await page.goto("/tests/fixtures/kit.html?shimmer");
  const sentence = page.getByTestId("inline-names");
  await expect(sentence.locator(".k-name-band")).toHaveCount(3);
  // Words here can't be selected (#483); in a conversation they can.
  await page.addStyleTag({ content: `[data-testid="inline-names"] { user-select: text; -webkit-user-select: text; }` });
  // What a screen reader hears, and what selecting the sentence copies:
  // each name once.
  const heard = await sentence.ariaSnapshot();
  for (const who of ["Jules", "Eli", "Sam"]) expect(heard.split(who).length - 1, `${who} heard`).toBe(1);
  const copied = await sentence.evaluate((node) => {
    const selection = window.getSelection();
    selection?.selectAllChildren(node);
    return selection?.toString() ?? "";
  });
  expect(copied.replace(/\s+/g, " ").trim()).toBe("Replying to Jules: Eli and Sam are typing, inside a sentence, in its own size and line.");

  // And with plain names on, or reduced motion, no band at all.
  await page.evaluate(() => document.documentElement.setAttribute("data-normalize", "true"));
  await expect(sentence.locator(".k-name-band").first()).toBeHidden();
  expect(await sentence.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.evaluate(() => document.documentElement.removeAttribute("data-normalize"));
  await expect(sentence.locator(".k-name-band").first()).toBeAttached();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(sentence.locator(".k-name-band").first()).toBeHidden();
  expect(await sentence.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
});

test("on the Linux app the page paints the band itself, as before, and it stops as it did (#532)", async ({ page }) => {
  await page.goto("/tests/fixtures/kit.html?shimmer");
  // WebKitGTK does less work repainting the name than moving layers
  // (core/shimmer.ts), so the Linux app marks the page for that.
  await page.evaluate(() => {
    document.documentElement.dataset.shimmer = "paint";
  });
  const section = page.locator("[data-section='names']");
  const lit = section.locator(".name[data-name-effect='shimmer']:not([data-dim])");
  const dim = section.locator(".name[data-name-effect='shimmer'][data-dim]");
  await expect(lit).toHaveCount(12 + 5 + 3);
  const painted = (names: Locator) =>
    names.evaluateAll((nodes) =>
      nodes.map((node) => {
        const moving = node.getAnimations({ subtree: true }).map((running) => {
          const effect = running.effect;
          const keyframes = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
          // Chromium names the longhands (backgroundPositionX and Y), WebKit the shorthand.
          const moves = [...new Set(keyframes.flatMap((frame) => Object.keys(frame)))].filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key));
          return moves.every((key) => key.startsWith("backgroundPosition")) ? "background-position" : moves.join(" ");
        });
        const band = node.querySelector(".k-name-band-place");
        return { moving, band: band ? getComputedStyle(band).display : "none", layers: getComputedStyle(node).backgroundImage.split("linear-gradient").length - 1 };
      }),
    );
  // The band is the name's own second background, moving; no window.
  for (const name of await painted(lit)) expect(name).toEqual({ moving: ["background-position"], band: "none", layers: 2 });
  // The lights off: nothing moves.
  for (const name of await painted(dim)) expect(name.moving).toEqual([]);
  // Reduced motion: their paint stays, the band goes.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const name of await painted(lit)) expect(name).toEqual({ moving: [], band: "none", layers: 1 });
});
