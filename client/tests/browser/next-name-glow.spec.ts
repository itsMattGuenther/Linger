import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Style } from "../../src/generated/Style";
import type { User } from "../../src/generated/User";
import { people } from "../fixtures/next/evening";

// A glowing name's light fades out past the name's box in a list row and in
// a voice chip, as it does at the top of the list, in chat and on the person
// card (#287). The glow is a drop shadow of the drawn name that reaches past
// its box (#272). A row's title and a chip's text used to cut everything
// inside them off at that box, which drew the light as a faint rectangle.
// The name cuts its own letters and draws its own "…", so a long name still
// ends in one, and the row and the chip keep their size and their places.
//
// Driven in the real list window (tests/fixtures/next-list-window.tsx), with
// people restyled by gateway frames, as a server would. Pixels are read from
// screenshots: the name as drawn, the same place with the name hidden (what's
// behind it), and its letters in white on black (where the letters are). The
// app is dark only (docs/design/system.md, "Tokens"), so there is one theme.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const SHEETS = "test-results/name-glow";

type Look = Pick<Style, "fill" | "effect">;

const AMBER_GLOW: Look = { fill: { kind: "solid", color: "amber" }, effect: "glow" };
const GRADIENT_GLOW: Look = { fill: { kind: "gradient", from: "violet", to: "sky" }, effect: "glow" };
const LONG = "Eli, whose name is far too long for any row in the list";

const styled = (user: User, look: Look, extra: Partial<User> = {}): User => ({ ...user, ...extra, style: { ...user.style, ...look } });

async function open(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect(rows(page, "People here").first()).toBeVisible();
}

const restyle = (page: Page, user: User) => page.evaluate(([server, d]) => window.core?.frame(server, { op: "user.update", d } as never), [HOME, user] as const);

const rows = (page: Page, list: string) => page.getByRole("list", { name: list, exact: true }).locator(":scope > li");
const inRow = (page: Page, who: string) => rows(page, "People here").filter({ hasText: who }).locator("[data-kit='Name']");

/** Join voice in #general as a chat window would ask, once the connection is up. */
async function joinGeneral(page: Page): Promise<Locator> {
  const bar = page.getByRole("region", { name: /In voice/ });
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.core?.ask("next:intent", { kind: "voice.join", server: "https://good-company.example", roomId: "r-general" }));
        await page.waitForTimeout(250);
        return bar.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  return bar;
}

const inChip = (bar: Locator, who: string) => bar.getByRole("list", { name: "Who's in voice" }).getByRole("listitem").filter({ hasText: who }).locator("[data-kit='Name']");

/** Wait until a name glows in its own face and has stopped moving. */
async function settled(page: Page, name: Locator) {
  await expect(name).toHaveAttribute("data-name-effect", "glow");
  await page.evaluate(() => document.fonts.ready);
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await name.boundingBox());
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [200] })
    .toBe(true);
  await page.mouse.move(0, 0);
}

// --- Reading pixels --------------------------------------------------------

type Lab = [number, number, number];
type Rgb = [number, number, number];

interface Shot {
  w: number;
  h: number;
  data: Uint8Array;
}

/** A region of the page as RGBA pixels, decoded by the page's own canvas. */
async function shoot(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  const png = await page.screenshot({ clip, animations: "disabled" });
  const decoded = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0);
    return { w: bitmap.width, h: bitmap.height, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  }, png.toString("base64"));
  return { w: decoded.w, h: decoded.h, data: Uint8Array.from(decoded.data) };
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function oklab([r, g, b]: Rgb): Lab {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** How far apart two colors look (OKLab distance; about 0.02 is where people start to see it). */
const apart = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const rgbAt = (shot: Shot, i: number): Rgb => [shot.data[i * 4] ?? 0, shot.data[i * 4 + 1] ?? 0, shot.data[i * 4 + 2] ?? 0];

/** Distances (in pixels, 3-4 chamfer) from every pixel to the nearest letter pixel. */
function distances(ink: boolean[], w: number, h: number): Float32Array {
  const far = 1e9;
  const d = new Float32Array(w * h).map((_, i) => (ink[i] ? 0 : far));
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? far : (d[y * w + x] ?? far));
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      d[i] = Math.min(d[i] ?? far, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y -= 1)
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      d[i] = Math.min(d[i] ?? far, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  return d.map((value) => value / 3);
}

const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];

/** Rings around the letters, in ems of the name's own size, as next-name-paint.spec.ts compares glows. */
const RINGS: [number, number][] = [
  [0.05, 0.15],
  [0.15, 0.3],
  [0.3, 0.5],
];

/** How far out from the box's edge the light is read as "far", in ems. */
const FAR = 1.2;

interface Light {
  /**
   * The light at each edge of the name's box: how far the paint is from
   * what's behind it (OKLab distance, averaged along the edge, letters left
   * out), one pixel inside the edge, one pixel outside it, and `FAR` ems out.
   */
  sides: Record<Side, { inside: number; outside: number; far: number }>;
  /** The light around the letters per ring in `RINGS`. */
  rings: number[];
}

/** The light a name gives off, around its letters and across the edges of its box. */
async function lightOf(page: Page, name: Locator): Promise<Light> {
  const { box, em } = await name.evaluate((node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, em: Number.parseFloat(getComputedStyle(node).fontSize) };
  });
  const pad = Math.ceil(em * (FAR + 0.3));
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = { x, y, width: Math.ceil(box.x + box.width + pad) - x, height: Math.ceil(box.y + box.height + pad) - y };
  const painted = await shoot(page, clip);
  await name.evaluate((node: HTMLElement) => node.style.setProperty("visibility", "hidden"));
  const behind = await shoot(page, clip);
  await name.evaluate((node: HTMLElement) => {
    node.style.removeProperty("visibility");
    node.dataset.probe = "letters";
  });
  const letters = await page.addStyleTag({
    content: `[data-probe="letters"] { background: #000 !important; background-clip: border-box !important; -webkit-background-clip: border-box !important; color: #fff !important; -webkit-text-fill-color: #fff !important; text-shadow: none !important; filter: none !important; animation: none !important; }`,
  });
  const mask = await shoot(page, clip);
  await name.evaluate((node: HTMLElement) => delete node.dataset.probe);
  await letters.evaluate((node: Element) => node.remove());

  const { w, h } = painted;
  const n = w * h;
  const scale = w / clip.width;
  const [left, top, right, bottom] = [box.x, box.y, box.x + box.width, box.y + box.height];
  // Letters are drawn only inside the name's box (it cuts them), in white on
  // the box's black. Any trace of one counts, so what's read as light starts
  // past a letter's softened edge.
  const ink: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    const [cx, cy] = [clip.x + ((i % w) + 0.5) / scale, clip.y + (Math.floor(i / w) + 0.5) / scale];
    const inBox = cx >= left && cx < right && cy >= top && cy < bottom;
    ink.push(inBox && (mask.data[i * 4] ?? 0) >= 16);
  }
  const away = distances(ink, w, h);
  const bands = Object.fromEntries(SIDES.map((side) => [side, { inside: { sum: 0, count: 0 }, outside: { sum: 0, count: 0 }, far: { sum: 0, count: 0 } }])) as Record<
    Side,
    Record<"inside" | "outside" | "far", { sum: number; count: number }>
  >;
  const rings = RINGS.map(() => ({ sum: 0, count: 0 }));
  for (let i = 0; i < n; i += 1) {
    if (ink[i]) continue;
    const [cx, cy] = [clip.x + ((i % w) + 0.5) / scale, clip.y + (Math.floor(i / w) + 0.5) / scale];
    const light = apart(oklab(rgbAt(painted, i)), oklab(rgbAt(behind, i)));
    const ems = (away[i] ?? 0) / (em * scale);
    RINGS.forEach(([from, to], k) => {
      const ring = rings[k];
      if (ring && ems >= from && ems < to) {
        ring.sum += light;
        ring.count += 1;
      }
    });
    // Out from each edge, in CSS pixels, along that edge's length.
    const across = cx >= left && cx < right;
    const along = cy >= top && cy < bottom;
    const out: [Side, number, boolean][] = [
      ["top", top - cy, across],
      ["bottom", cy - bottom, across],
      ["left", left - cx, along],
      ["right", cx - right, along],
    ];
    for (const [side, d, onEdge] of out) {
      if (!onEdge) continue;
      const band = d >= -1.5 && d < -0.5 ? "inside" : d >= 0.5 && d < 1.5 ? "outside" : d >= FAR * em && d < FAR * em + 1 ? "far" : null;
      if (!band) continue;
      bands[side][band].sum += light;
      bands[side][band].count += 1;
    }
  }
  const mean = ({ sum, count }: { sum: number; count: number }) => (count ? sum / count : Number.NaN);
  return {
    sides: Object.fromEntries(SIDES.map((side) => [side, { inside: mean(bands[side].inside), outside: mean(bands[side].outside), far: mean(bands[side].far) }])) as Light["sides"],
    rings: rings.map(mean),
  };
}

const show = (light: Light) =>
  `${SIDES.map((side) => `${side} ${light.sides[side].inside.toFixed(3)}|${light.sides[side].outside.toFixed(3)}|${light.sides[side].far.toFixed(3)}`).join(", ")}; rings ${light.rings.map((ring) => ring.toFixed(3)).join(" ")}`;

/**
 * The light fades out past the box on every side: just outside an edge it is
 * nearly what it is just inside, with no step down to nothing, and further
 * out it has faded. A cut at the box is a step: light inside, none outside.
 */
function expectFades(light: Light, where: string, sides: readonly Side[] = SIDES) {
  for (const side of sides) {
    const { inside, outside, far } = light.sides[side];
    expect(inside, `${where}: there is light just inside the box's ${side} edge (${show(light)})`).toBeGreaterThan(0.015);
    expect(outside, `${where}: the light carries on past the ${side} edge, with no step (${show(light)})`).toBeGreaterThan(inside * 0.5);
    expect(far, `${where}: and fades out further on (${show(light)})`).toBeLessThan(outside * 0.5);
  }
}

/** No light at all past the box: the glow is off. */
function expectDark(light: Light, where: string) {
  for (const side of SIDES) expect(light.sides[side].outside, `${where}: nothing past the ${side} edge (${show(light)})`).toBeLessThan(0.01);
}

const filterOf = (name: Locator) => name.evaluate((node) => getComputedStyle(node).filter);

// --- The tests -------------------------------------------------------------

for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale });

    for (const [label, look] of [
      ["a solid color", AMBER_GLOW],
      ["a gradient", GRADIENT_GLOW],
    ] as const) {
      test(`a glowing name in ${label} fades out past its box in a list row and a voice chip`, async ({ page }) => {
        await open(page);
        await restyle(page, styled(people.eli, look));
        const bar = await joinGeneral(page);
        const row = inRow(page, "Eli");
        const chip = inChip(bar, "Eli");
        await settled(page, row);
        await settled(page, chip);

        const inList = await lightOf(page, row);
        const onChip = await lightOf(page, chip);
        test.info().annotations.push({ type: "light", description: `row: ${show(inList)} / chip: ${show(onChip)}` });
        expectFades(inList, "in a row");
        expectFades(onChip, "in a voice chip");

        // And the light around the letters is the same, for the name's size,
        // as on the person card, where nothing cuts it (#272).
        await rows(page, "People here").filter({ hasText: "Eli" }).getByRole("button").first().click();
        const card = page.getByRole("dialog", { name: "Eli" });
        await expect(card).toBeVisible();
        await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((running) => running.finished)));
        const onCard = await lightOf(page, card.locator("[data-kit='Name']").first());
        test.info().annotations.push({ type: "card", description: show(onCard) });
        for (const [where, light] of [
          ["in the row", inList],
          ["on the chip", onChip],
        ] as const)
          onCard.rings.forEach((ring, i) => {
            const here = light.rings[i] ?? 0;
            expect(Math.abs(here - ring), `ring ${i + 1}: ${where} ${here.toFixed(3)}, on the card ${ring.toFixed(3)}`).toBeLessThan(0.02);
          });
      });
    }

    test("a long glowing name still ends in an ellipsis, and nothing about the rows or the chips moves", async ({ page }) => {
      await open(page);
      const bar = await joinGeneral(page);
      const layout = () =>
        page.locator(`[data-screen='list'] ul[aria-label='People here'] > li, [data-screen='list'] ul[aria-label="Who's in voice"] > li`).evaluateAll((items) =>
          items.map((item) => {
            const outer = (item.querySelector(".k-row-main, .k-chip") ?? item).getBoundingClientRect();
            const name = item.querySelector("[data-kit='Name']")?.getBoundingClientRect();
            return { who: item.textContent, x: outer.x, y: outer.y, width: outer.width, height: outer.height, name: name ? [name.x, name.y, name.width, name.height] : null };
          }),
        );
      await restyle(page, styled(people.eli, AMBER_GLOW, { display_name: LONG }));
      await restyle(page, styled(people.jules, GRADIENT_GLOW));
      await restyle(page, styled(people.dave, AMBER_GLOW));
      const row = inRow(page, "Eli, whose");
      await settled(page, row);
      await settled(page, inChip(bar, "Jules"));

      // Everything sits where it did when the title and the chip's text cut
      // their name at its box, as they used to.
      const now = await layout();
      const cutting = await page.addStyleTag({ content: ".k-row-title, .k-chip-text { overflow: hidden !important; }" });
      const before = await layout();
      await cutting.evaluate((node: Element) => node.remove());
      expect(now.length).toBeGreaterThan(5);
      expect(now).toEqual(before);

      // Every person's row is 48px, every name starts on one edge, in a 20px
      // line at the same height in its row; every chip is 24px.
      const personRows = now.filter((one) => one.height === 48);
      expect(personRows.length).toBeGreaterThan(3);
      expect(new Set(personRows.map((one) => one.name?.[0])).size).toBe(1);
      expect(new Set(personRows.map((one) => (one.name?.[1] ?? 0) - one.y)).size).toBe(1);
      expect(new Set(personRows.map((one) => one.name?.[3]))).toEqual(new Set([20]));
      expect(new Set(now.filter((one) => one.height !== 48).map((one) => one.height))).toEqual(new Set([24]));

      // The long name is cut by its own box, which draws the "…".
      const cut = await row.evaluate((node) => {
        const style = getComputedStyle(node);
        const range = document.createRange();
        range.selectNodeContents(node);
        return {
          over: node.scrollWidth > node.clientWidth,
          ellipsis: style.textOverflow,
          clips: style.overflowX,
          nowrap: style.whiteSpace,
          longer: range.getBoundingClientRect().width > node.getBoundingClientRect().width,
        };
      });
      expect(cut).toEqual({ over: true, ellipsis: "ellipsis", clips: "hidden", nowrap: "nowrap", longer: true });
      // Its letters stop at that box, short of the note beside it: drawn in
      // white on black, nothing white is painted past it.
      const note = rows(page, "People here").filter({ hasText: "Eli, whose" }).locator(".k-row-note");
      await expect(note).toBeVisible();
      const [nameBox, noteBox] = [await row.boundingBox(), await note.boundingBox()];
      if (!nameBox || !noteBox) throw new Error("nothing to measure");
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(noteBox.x);
      await row.evaluate((node: HTMLElement) => (node.dataset.probe = "letters"));
      const letters = await page.addStyleTag({
        content: `[data-probe="letters"] { background: #000 !important; background-clip: border-box !important; -webkit-background-clip: border-box !important; color: #fff !important; -webkit-text-fill-color: #fff !important; filter: none !important; }`,
      });
      const beyond = await shoot(page, { x: nameBox.x + nameBox.width + 1, y: nameBox.y, width: 12, height: nameBox.height });
      await letters.evaluate((node: Element) => node.remove());
      await row.evaluate((node: HTMLElement) => delete node.dataset.probe);
      let white = 0;
      for (let i = 0; i < beyond.w * beyond.h; i += 1) if ([0, 1, 2].every((c) => (beyond.data[i * 4 + c] ?? 0) > 230)) white += 1;
      expect(white, "letters painted past the name's box").toBe(0);
      // And its light still fades out past the box. (At its end are the
      // three small dots of the "…", which give off too little to measure.)
      expectFades(await lightOf(page, row), "a long name in a row", ["top", "bottom", "left"]);

      // The sheet, for a person to look at.
      await page.mouse.move(0, 0);
      const heading = page.locator("[data-kit='SectionLabel']", { hasText: "People" }).first();
      const [from, to] = [await heading.boundingBox(), await rows(page, "People here").last().boundingBox()];
      if (!from || !to) throw new Error("nothing to shoot");
      await page.screenshot({
        path: `${SHEETS}/${test.info().project.name}-${scale * 100}-long.png`,
        clip: { x: 0, y: from.y, width: 340, height: to.y + to.height + 8 - from.y },
        animations: "disabled",
      });
    });

    // For people to look at, not asserted on: the People section and the
    // voice bar, with four people glowing, one hovered.
    test("review sheet", async ({ page }) => {
      await open(page);
      await restyle(page, styled(people.eli, AMBER_GLOW));
      await restyle(page, styled(people.jules, { fill: { kind: "gradient", from: "fern", to: "teal" }, effect: "glow" }));
      await restyle(page, styled(people.dave, { fill: { kind: "solid", color: "cyan" }, effect: "glow" }));
      await restyle(page, styled(people.callie, { fill: { kind: "gradient", from: "violet", to: "orchid" }, effect: "glow" }));
      const bar = await joinGeneral(page);
      await settled(page, inRow(page, "Callie"));
      await settled(page, inChip(bar, "Jules"));
      const project = test.info().project.name;
      const heading = page.locator("[data-kit='SectionLabel']", { hasText: "People" }).first();
      const shootPeople = async (name: string) => {
        const [from, to] = [await heading.boundingBox(), await rows(page, "People here").last().boundingBox()];
        if (!from || !to) throw new Error("nothing to shoot");
        await page.screenshot({
          path: `${SHEETS}/${project}-${scale * 100}-${name}.png`,
          clip: { x: 0, y: from.y, width: 340, height: to.y + to.height + 8 - from.y },
          animations: "disabled",
        });
      };
      await shootPeople("people");
      await bar.screenshot({ path: `${SHEETS}/${project}-${scale * 100}-voice.png`, animations: "disabled" });
      await rows(page, "People here").filter({ hasText: "Jules" }).hover();
      await shootPeople("people-hover");
    });
  });
}

test("plain names, reduced motion and high contrast still turn the glow off in a row and a chip", async ({ page }) => {
  await open(page);
  await restyle(page, styled(people.eli, AMBER_GLOW));
  const bar = await joinGeneral(page);
  const [row, chip] = [inRow(page, "Eli"), inChip(bar, "Eli")];
  await settled(page, row);
  await settled(page, chip);
  expect(await filterOf(row)).toContain("drop-shadow");
  expect(await filterOf(chip)).toContain("drop-shadow");

  const off = async (why: string) => {
    for (const [where, name] of [
      ["row", row],
      ["chip", chip],
    ] as const) {
      expect(await filterOf(name), `${why}, ${where}`).toBe("none");
      expectDark(await lightOf(page, name), `${why}, ${where}`);
    }
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await off("reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.emulateMedia({ forcedColors: "active" });
  await off("high contrast");
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => document.documentElement.setAttribute("data-normalize", "true"));
  await off("plain names");
});
