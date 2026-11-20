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
//
// And that it doesn't cross forever. Anything that moves has the page hand
// the window a new frame every refresh, and in the Linux app every frame is
// the whole window copied into place: an idle list with Shimmer names kept
// a 165 Hz NVIDIA desktop at 58% of a core and 50 W. So in the list the light
// crosses three times when its person arrives (Linger starting, or back from
// idle, away or offline: `lib/arrivals.ts`, whose own tests hold the timing),
// every name of theirs in step, and a name drawn again because the layout
// around it changed picks that up or stays still; once more for a mouse; and
// the band is then gone. A card crosses when it opens; a conversation never
// does (`next-name-paint.spec.ts`).

const HOME = "https://good-company.example";

/** A gateway frame restyling somebody, as the server sends it. */
const restyle = (page: Page, user: User) => page.evaluate(([server, d]) => window.core?.frame(server, { op: "user.update", d } as never), [HOME, user] as const);

const shimmering = (page: Page) => page.locator(".name[data-name-effect='shimmer']:not([data-dim])");

/** Somebody's presence changes, as the server says it. */
const move = (page: Page, user_id: string, state: string, room_id: string | null = null) =>
  page.evaluate(([server, user_id, state, room_id]) => window.core?.frame(server, { op: "presence.update", d: { user_id, state, room_id, away_message: null } } as never), [HOME, user_id, state, room_id] as const);

/** Every crossing under these names, done: what their last round's end does. */
const finish = (names: Locator) =>
  names.evaluateAll((nodes) => {
    for (const node of nodes) for (const running of node.getAnimations({ subtree: true })) running.finish();
  });

/** Held where they are, for tests that read the band's pixels, however long that takes. */
const holdBands = (page: Page) => page.addStyleTag({ content: `.k-name-band, .k-name-band::before { animation-play-state: paused !important; }` });

/**
 * The list, with Dave and Callie shimmering and both just back (idle, then
 * here again), so their light is crossing now: it crosses when somebody
 * arrives, and a test can't count on Linger having started less than 12
 * seconds ago. Neither is in voice, which keeps somebody lit through idle.
 * `hold` keeps every band still where it starts, so a test reads the
 * crossings at its own pace and ends them itself, however slow the machine.
 */
async function listOfShimmers(page: Page, { hold = false } = {}) {
  await page.setViewportSize({ width: 340, height: 820 });
  await page.goto("/tests/fixtures/next-list-window.html?one");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  if (hold) await holdBands(page);
  const look = { fill: { kind: "gradient", from: "violet", to: "sky" }, effect: "shimmer" } as const;
  for (const user of [people.dave, people.callie]) await restyle(page, { ...user, style: { ...user.style, ...look } });
  for (const user of [people.dave, people.callie]) await move(page, user.id, "idle");
  await expect(shimmering(page)).toHaveCount(0);
  // Back around, not into a room: coming into one puts up a card saying so
  // (#211), with their name in it too.
  await move(page, people.dave.id, "around");
  await move(page, people.callie.id, "around");
  await expect(shimmering(page)).toHaveCount(2);
  await expect(shimmering(page).locator(".k-name-band[data-sweep='arrive']")).toHaveCount(2);
}

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
  await listOfShimmers(page);

  // Running, in step: each name's window and its copy, started together,
  // three rounds of 4 seconds, changing nothing but where they are.
  await expect
    .poll(async () => (await motion(shimmering(page))).every((name) => name.parts.every((part) => part.start !== null)))
    .toBe(true);
  for (const name of await motion(shimmering(page))) {
    expect(name.own, `${name.who}'s name itself animates nothing`).toBe(0);
    expect(name.parts.map((part) => part.name).sort(), `${name.who}`).toEqual(["k-name-band", "k-name-band-letters"]);
    for (const part of name.parts) {
      expect(part.moves, `${name.who}'s ${part.name}`).toEqual(["transform"]);
      expect(part.length).toBe(4000);
      expect(part.rounds).toBe(3);
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

test("a list at rest draws nothing: a shimmering name crosses three times, then its band is gone (#532)", async ({ page }) => {
  await listOfShimmers(page, { hold: true });
  const bands = page.locator(".k-name-band");
  await expect(bands).toHaveCount(2);
  // Every crossing ends: its last round at most 12 seconds after the arrival
  // (less by however far in the band was drawn).
  const ends = await shimmering(page).evaluateAll((nodes) => nodes.flatMap((node) => node.getAnimations({ subtree: true }).map((running) => Number(running.effect?.getComputedTiming().endTime))));
  expect(ends).toHaveLength(4);
  for (const end of ends) {
    expect(end).toBeLessThanOrEqual(12000);
    expect(end).toBeGreaterThan(10000);
  }

  // Done with every animation on the list, which only a finite one can be:
  // the bands go, and nothing on the page moves, so it draws nothing.
  await page.evaluate(() => {
    for (const running of document.getAnimations()) running.finish();
  });
  await expect(bands).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getAnimations().map((running) => (running instanceof CSSAnimation ? running.animationName : "script")))).toEqual([]);
  // Still their colors: only the light rests.
  for (const image of await shimmering(page).evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundImage))) expect(image).toContain("linear-gradient");
});

test("pointing at a resting name crosses it once more; pointing while it crosses changes nothing (#532)", async ({ page }) => {
  await listOfShimmers(page, { hold: true });
  const callie = shimmering(page).filter({ hasText: "Callie" });
  await expect(callie.locator(".k-name-band")).toHaveAttribute("data-sweep", "arrive");
  // Mid-crossing, the pointer leaves the crossing it's on alone.
  await callie.locator(".k-name-band").evaluate((node: HTMLElement) => (node.dataset.seen = "yes"));
  await callie.hover();
  await expect(callie.locator(".k-name-band[data-seen='yes']")).toHaveAttribute("data-sweep", "arrive");
  await page.mouse.move(0, 0);
  await finish(callie);
  await expect(callie.locator(".k-name-band")).toHaveCount(0);

  // A finger is no pointer: on a phone it lands on names to scroll past them.
  await callie.dispatchEvent("pointerover", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(100);
  await expect(callie.locator(".k-name-band")).toHaveCount(0);

  // At rest, pointed at: one crossing, the window and its copy together.
  await callie.hover();
  await expect(callie.locator(".k-name-band")).toHaveAttribute("data-sweep", "point");
  const rounds = await callie.evaluate((node) => node.getAnimations({ subtree: true }).map((running) => running.effect?.getComputedTiming().iterations));
  expect(rounds).toEqual([1, 1]);
  await finish(callie);
  await expect(callie.locator(".k-name-band")).toHaveCount(0);
});

test("somebody coming back crosses their name three times again (#532)", async ({ page }) => {
  await listOfShimmers(page, { hold: true });
  // Dave, in a room without voice: somebody in voice stays lit.
  const dave = page.locator("[data-kit='Name']", { hasText: "Dave" });
  await expect(dave).toHaveCount(1);
  await finish(dave);
  await expect(dave.locator(".k-name-band")).toHaveCount(0);
  // Idle: the lights go off, and with them the shimmer.
  await move(page, people.dave.id, "idle");
  await expect(dave).toHaveAttribute("data-dim", "yes");
  await expect(dave.locator(".k-name-band")).toHaveCount(0);
  // Back: three crossings, as when the name first showed up.
  await move(page, people.dave.id, "around");
  await expect(dave).not.toHaveAttribute("data-dim");
  await expect(dave.locator(".k-name-band")).toHaveAttribute("data-sweep", "arrive");
  const rounds = await dave.evaluate((node) => node.getAnimations({ subtree: true }).map((running) => running.effect?.getComputedTiming().iterations));
  expect(rounds).toEqual([3, 3]);
});

test("a folded server's line: a name rebuilt as it changes shape stays still, and one crossing goes on where it was (#532)", async ({ page }) => {
  // Several servers, each folded to its one line (#712).
  await page.setViewportSize({ width: 340, height: 820 });
  await page.goto("/tests/fixtures/next-list-window.html");
  await holdBands(page);
  await page.evaluate(() => document.fonts.ready);
  const line = page.getByRole("region", { name: "The Good Company", exact: true }).locator(".nx-srv-line-text");
  await expect(line).toBeVisible();
  for (const user of [people.eli, people.jules]) await restyle(page, { ...user, style: { ...user.style, effect: "shimmer" } });
  /** Who is in #general's voice, in the server's order: the line names them. */
  const inVoice = (...ids: string[]) =>
    page.evaluate(
      ([server, ids]) => window.core?.frame(server, { op: "voice.state", d: { room_id: "r-general", peers: ids.map((user_id) => ({ session_id: `s-${user_id}`, user_id, controls: { muted: false, deafened: false } })) } } as never),
      [HOME, ids] as const,
    );
  const names = line.locator("[data-kit='Name']");
  const bands = line.locator(".k-name-band");
  // Both in its voice, their light over (Linger started a while ago).
  await inVoice(people.eli.id, people.jules.id);
  await expect(names).toHaveText(["Eli", "Jules"]);
  await finish(names);
  await expect(bands).toHaveCount(0);
  // The order turning round, the line going from voice to the room and back
  // to one name in voice: names moved and rebuilt, nobody arrived.
  await inVoice(people.jules.id, people.eli.id);
  await expect(names).toHaveText(["Jules", "Eli"]);
  await inVoice();
  await expect(line).toHaveText(/in #general/);
  await inVoice(people.eli.id);
  await expect(names).toHaveText(["Eli"]);
  await expect(bands).toHaveCount(0);

  // Eli away and back while the line shows him: he arrived, so it crosses.
  await move(page, people.eli.id, "away");
  await move(page, people.eli.id, "in_room", "r-general");
  await expect(bands).toHaveCount(1);
  /** How far into the crossings a band is: its own time, plus how far in it was drawn (its negative delay). */
  const into = () =>
    bands.evaluate((node) => {
      const timing = node.getAnimations()[0]?.effect?.getComputedTiming();
      return Number(timing?.localTime ?? 0) - Number(timing?.delay ?? 0);
    });
  const first = await into();
  await page.waitForTimeout(600);
  // The server opened and folded again mid-crossing: the line is drawn anew,
  // and his name picks the crossing up that far in rather than starting it
  // again.
  const toggle = page.getByRole("region", { name: "The Good Company", exact: true }).locator("button.nx-srv-toggle");
  await toggle.click();
  await expect(line).toHaveText(/you're/);
  await toggle.click();
  await expect(names).toHaveText(["Eli"]);
  await expect(bands).toHaveCount(1);
  await expect(bands).toHaveAttribute("data-sweep", "arrive");
  const after = await into();
  expect(after).toBeGreaterThan(first + 400);
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
      await holdBands(page);
      await page.evaluate(() => document.fonts.ready);
      const section = page.locator("[data-section='names']");
      await section.scrollIntoViewIfNeeded();
      const names = section.locator(".name[data-name-effect='shimmer']:not([data-dim])");
      // Every face in a row, the display, body, control and meta sizes, a
      // long name cut short with "…", two with emoji in them (#512), three
      // names inside a sentence, and one with a character that turns text
      // around (#488).
      await expect(names).toHaveCount(12 + 5 + 2 + 3 + 1);
      // That one turned at its start too, so all its letters are drawn
      // backwards: the band still has to lie on them.
      await page.getByTestId("turned-name").locator("[data-kit='Name']").evaluate((node) => {
        const turned = `\u202E${(node.textContent ?? "").replace(/\u202E/g, "")}`;
        const letters = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
        if (letters) letters.textContent = turned;
        node.querySelector(".k-name-band")?.setAttribute("data-letters", turned);
      });
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
  await holdBands(page);
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
