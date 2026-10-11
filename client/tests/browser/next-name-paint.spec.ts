import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Style } from "../../src/generated/Style";
import type { User } from "../../src/generated/User";
import { people } from "../fixtures/next/evening";

// One person's styled name, in a message and on their card, should read as
// the same name (SPEC §4.5, #272). Both are the kit's `Name`, so its own
// colors never differed; what could differ is what's drawn with it and behind
// it: how far a gradient or a shimmer's band is spread, a glow, and the card's
// wash of their color. These tests compare what is actually painted, sampled
// from screenshots, in the real chat window (tests/fixtures/next-chat-window.tsx).
//
// Measured at 200%, so a name at message size has enough whole pixels inside
// its letters to average. The new client has one theme (dark); a light one is
// an open decision (docs/design/system.md, "Tokens").

test.use({ viewport: { width: 780, height: 820 }, deviceScaleFactor: 2 });

const SERVER = "https://good-company.example";
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;
const SHEETS = "test-results/name-paint";

type Look = Pick<Style, "fill" | "effect">;

const SOLID: Style["fill"] = { kind: "solid", color: "violet" };
const GRADIENT: Style["fill"] = { kind: "gradient", from: "violet", to: "sky" };
const GRADIENT_SHIMMER: Look = { fill: GRADIENT, effect: "shimmer" };
const GRADIENT_GLOW: Look = { fill: GRADIENT, effect: "glow" };

/**
 * Eli, in each look a name can have: a solid color and a gradient, with each
 * effect. Matt's case (#272) was a pixel face, whose letters are whole pixels
 * at any size; one look is in an ordinary face too.
 */
const LOOKS: [string, Look, string][] = [
  ["solid", { fill: SOLID, effect: "none" }, "silkscreen"],
  ["gradient", { fill: GRADIENT, effect: "none" }, "silkscreen"],
  ["solid glow", { fill: SOLID, effect: "glow" }, "silkscreen"],
  ["gradient glow", GRADIENT_GLOW, "silkscreen"],
  ["solid shimmer", { fill: SOLID, effect: "shimmer" }, "silkscreen"],
  ["gradient shimmer", GRADIENT_SHIMMER, "silkscreen"],
  ["gradient glow in Geist Sans", GRADIENT_GLOW, "geist-sans"],
];

function eliIn(look: Look, face = "silkscreen"): User {
  return { ...people.eli, style: { ...people.eli.style, font_key: face, weight: face === "silkscreen" ? 400 : 700, italic: false, ...look } };
}

async function open(page: Page, eli: User) {
  await page.route(`${SERVER}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.goto(`/tests/fixtures/next-chat-window.html?room=r-general`);
  await expect(page.locator(".nx-pane")).toBeVisible();
  await page.evaluate((user) => window.owner?.frame({ op: "user.update", d: user } as never), eli);
  await page.mouse.move(0, 0);
  await settled(page, inChat(page).locator("[data-kit='Name']"), eli.style);
}

/**
 * Wait until a name is drawn in the look it was given, in its own face, and
 * has stopped moving (the conversation settles as pictures load).
 */
async function settled(page: Page, name: Locator, style: Style) {
  if (style.fill.kind === "gradient") await expect(name).toHaveAttribute("data-name-fill", "gradient");
  else await expect(name).not.toHaveAttribute("data-name-fill");
  if (style.effect === "none") await expect(name).not.toHaveAttribute("data-name-effect");
  else await expect(name).toHaveAttribute("data-name-effect", style.effect);
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
}

/** Eli's name on his newest message. */
const inChat = (page: Page) => page.locator(".nx-msg[data-head='yes'] .nx-msg-person", { hasText: "Eli" }).last();
const card = (page: Page) => page.getByRole("dialog", { name: "Eli" });

async function openCard(page: Page) {
  await inChat(page).click();
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((node) => Promise.all(node.getAnimations().map((running) => running.finished)));
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
async function shoot(page: Page, clip: { x: number; y: number; width: number; height: number }, animations: "disabled" | "allow"): Promise<Shot> {
  const png = await page.screenshot({ clip, animations });
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

const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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

/** Rings around the letters, in ems of the name's own size, for comparing glows. */
const RINGS: [number, number][] = [
  [0.05, 0.15],
  [0.15, 0.3],
  [0.3, 0.5],
];

interface Paint {
  /** The painted color inside the letters, in four bands from the first letter to the last. */
  bands: Lab[];
  bandsRgb: Rgb[];
  /** How far the paint around the letters is from what's behind them, per ring in `RINGS`. */
  glow: number[];
  /** What's behind the name, averaged over its box, and the lightest pixel of it. */
  behind: Lab;
  lightestBehind: Rgb;
  /** Whole pixels inside the letters that were sampled. */
  inked: number;
}

/**
 * What a name paints: three shots of the same place, the name as drawn, the
 * name hidden (what's behind it), and its letters in white on black (which
 * pixels are inside the letters).
 */
async function paintOf(page: Page, name: Locator, animations: "disabled" | "allow" = "disabled"): Promise<Paint> {
  const { box, em } = await name.evaluate((node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, em: Number.parseFloat(getComputedStyle(node).fontSize) };
  });
  const pad = Math.ceil(em * 0.6);
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad), width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad) };
  const painted = await shoot(page, clip, animations);
  await name.evaluate((node: HTMLElement) => node.style.setProperty("visibility", "hidden"));
  const behind = await shoot(page, clip, animations);
  await name.evaluate((node: HTMLElement) => {
    node.style.removeProperty("visibility");
    node.dataset.probe = "letters";
  });
  const letters = await page.addStyleTag({
    content: `[data-probe="letters"] { background: #000 !important; background-clip: border-box !important; -webkit-background-clip: border-box !important; color: #fff !important; -webkit-text-fill-color: #fff !important; text-shadow: none !important; filter: none !important; animation: none !important; }`,
  });
  const mask = await shoot(page, clip, animations);
  await name.evaluate((node: HTMLElement) => delete node.dataset.probe);
  await letters.evaluate((node: Element) => node.remove());

  const { w, h } = painted;
  const n = w * h;
  const scale = w / clip.width;
  const boxLeft = (box.x - clip.x) * scale;
  const boxTop = (box.y - clip.y) * scale;
  const inBox = (i: number) => {
    const [x, y] = [i % w, Math.floor(i / w)];
    return x >= boxLeft && x < boxLeft + box.width * scale && y >= boxTop && y < boxTop + box.height * scale;
  };
  // Letters are drawn only inside the name's box (it clips them), in white
  // on the box's black.
  const inside: boolean[] = [];
  const ink: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    const white = inBox(i) ? (mask.data[i * 4] ?? 0) : 0;
    inside.push(white >= 240);
    // Any trace of a letter, so the rings start past its softened edge.
    ink.push(white >= 16);
  }
  let first = w;
  let last = 0;
  for (let i = 0; i < n; i += 1)
    if (inside[i]) {
      first = Math.min(first, i % w);
      last = Math.max(last, i % w);
    }
  const sums = Array.from({ length: 4 }, () => ({ lab: [0, 0, 0] as Lab, rgb: [0, 0, 0] as Rgb, count: 0 }));
  const away = distances(ink, w, h);
  const rings = RINGS.map(() => ({ sum: 0, count: 0 }));
  const behindBox = { lab: [0, 0, 0] as Lab, count: 0, lightest: [0, 0, 0] as Rgb };
  for (let i = 0; i < n; i += 1) {
    const x = i % w;
    const p = rgbAt(painted, i);
    const q = rgbAt(behind, i);
    if (inBox(i)) {
      const lab = oklab(q);
      behindBox.lab = [behindBox.lab[0] + lab[0], behindBox.lab[1] + lab[1], behindBox.lab[2] + lab[2]];
      behindBox.count += 1;
      if (luminance(q) > luminance(behindBox.lightest)) behindBox.lightest = q;
    }
    if (inside[i]) {
      const band = sums[Math.min(3, Math.floor(((x - first) / (last - first + 1)) * 4))];
      if (!band) continue;
      const lab = oklab(p);
      band.lab = [band.lab[0] + lab[0], band.lab[1] + lab[1], band.lab[2] + lab[2]];
      band.rgb = [band.rgb[0] + p[0], band.rgb[1] + p[1], band.rgb[2] + p[2]];
      band.count += 1;
    } else if (!ink[i]) {
      const ems = (away[i] ?? 0) / (em * scale);
      RINGS.forEach(([from, to], k) => {
        const ring = rings[k];
        if (ring && ems >= from && ems < to) {
          ring.sum += apart(oklab(p), oklab(q));
          ring.count += 1;
        }
      });
    }
  }
  const mean = <T extends number[]>(v: T, count: number) => v.map((c) => c / count) as T;
  return {
    bands: sums.map((band) => mean(band.lab, band.count)),
    bandsRgb: sums.map((band) => mean(band.rgb, band.count)),
    glow: rings.map((ring) => ring.sum / ring.count),
    behind: mean(behindBox.lab, behindBox.count),
    lightestBehind: behindBox.lightest,
    inked: sums.reduce((all, band) => all + band.count, 0),
  };
}

/** A token's color as the page resolves it, in OKLab. */
async function token(page: Page, name: string): Promise<Lab> {
  const rgb = await page.evaluate((property) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${property})`;
    document.body.append(probe);
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.fillStyle = getComputedStyle(probe).backgroundColor;
    probe.remove();
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, name);
  return oklab([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]);
}

const show = (lab: Lab) => lab.map((v) => v.toFixed(3)).join(" ");

// --- The tests -------------------------------------------------------------

test.describe("a name reads the same in a message and on its card (#272)", () => {
  for (const [label, look, face] of LOOKS) {
    test(label, async ({ page }) => {
      await open(page, eliIn(look, face));
      const chat = await paintOf(page, inChat(page).locator("[data-kit='Name']"));
      await openCard(page);
      const onCard = await paintOf(page, card(page).locator("[data-kit='Name']"));
      // The measurements, kept with the result for anybody comparing runs.
      test.info().annotations.push({
        type: "paint",
        description:
          `apart per band ${chat.bands.map((band, i) => apart(band, onCard.bands[i] ?? band).toFixed(4)).join(" ")}; ` +
          `glow in chat ${chat.glow.map((g) => g.toFixed(3)).join(" ")}, on the card ${onCard.glow.map((g) => g.toFixed(3)).join(" ")}; ` +
          `behind the card's name ${show(onCard.behind)}`,
      });

      // Enough of each name was sampled to mean something.
      expect(chat.inked).toBeGreaterThan(100);
      expect(onCard.inked).toBeGreaterThan(100);

      // The letters are the same colors, from the first letter to the last.
      chat.bands.forEach((band, i) => {
        const other = onCard.bands[i] ?? band;
        expect(apart(band, other), `band ${i + 1}: in chat ${show(band)}, on the card ${show(other)}`).toBeLessThan(0.02);
      });

      // A glow reaches as far, as strongly, for the name's size.
      if (look.effect === "glow") {
        chat.glow.forEach((ring, i) => {
          const other = onCard.glow[i] ?? ring;
          expect(Math.abs(ring - other), `glow ring ${i + 1}: in chat ${ring.toFixed(3)}, on the card ${other.toFixed(3)}`).toBeLessThan(0.02);
        });
        expect(chat.glow[0] ?? 0, "the glow shows").toBeGreaterThan(0.05);
      }

      // Nothing of their color is washed behind the name on the card: it
      // sits on the card's own surface.
      expect(apart(onCard.behind, await token(page, "--surface-popover")), `behind the card's name: ${show(onCard.behind)}`).toBeLessThan(0.01);

      // And every part of the name keeps 4.5:1 against the lightest pixel
      // actually behind it on the card.
      for (const band of onCard.bandsRgb) expect(contrast(band, onCard.lightestBehind)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("a shimmer caught mid-way is the same band across the same letters", async ({ page }) => {
    await open(page, eliIn(GRADIENT_SHIMMER));
    // Both bands stopped at the same point of their pass.
    const stop = (name: Locator) =>
      name.evaluate((node) => {
        for (const running of node.getAnimations()) {
          running.pause();
          const length = running.effect?.getComputedTiming().duration;
          running.currentTime = typeof length === "number" ? length * 0.45 : 0;
        }
      });
    await stop(inChat(page).locator("[data-kit='Name']"));
    const chat = await paintOf(page, inChat(page).locator("[data-kit='Name']"), "allow");
    await openCard(page);
    await stop(card(page).locator("[data-kit='Name']"));
    const onCard = await paintOf(page, card(page).locator("[data-kit='Name']"), "allow");
    chat.bands.forEach((band, i) => {
      const other = onCard.bands[i] ?? band;
      expect(apart(band, other), `band ${i + 1}: in chat ${show(band)}, on the card ${show(other)}`).toBeLessThan(0.03);
    });
  });

  test("a name's box is as wide as its letters wherever it is drawn, so its gradient spans them", async ({ page }) => {
    // Room in each name's box past its letters.
    const spare = () =>
      page.locator("[data-kit='Name']:not([data-size='inline'])").evaluateAll((nodes) =>
        nodes.map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return { name: node.textContent, spare: node.getBoundingClientRect().width - range.getBoundingClientRect().width };
        }),
      );
    // A conversation with a card open, then the list, whose top card holds
    // your own name in a column as the person card does.
    await open(page, eliIn(GRADIENT_SHIMMER));
    await openCard(page);
    const inChatWindow = await spare();
    await page.goto("/tests/fixtures/next-list.html");
    await expect(page.locator("[data-kit='Name']").first()).toBeVisible();
    const inList = await spare();
    expect(inChatWindow.length).toBeGreaterThan(3);
    expect(inList.length).toBeGreaterThan(3);
    // Only the 2px kept at the end for italic letters.
    for (const { name, spare: room } of [...inChatWindow, ...inList]) expect(room, `${name}'s box`).toBeLessThanOrEqual(3);
  });

  test("a glow goes with plain names and with high contrast", async ({ page }) => {
    await open(page, eliIn(GRADIENT_GLOW));
    const name = inChat(page).locator("[data-kit='Name']");
    const glow = () => name.evaluate((node) => getComputedStyle(node).filter);
    expect(await glow()).toContain("drop-shadow");
    await page.emulateMedia({ forcedColors: "active" });
    expect(await glow()).toBe("none");
    await page.emulateMedia({ forcedColors: "none" });
    expect(await glow()).toContain("drop-shadow");
    await page.evaluate(() => document.documentElement.setAttribute("data-normalize", "true"));
    expect(await glow()).toBe("none");
  });
});

// For people to look at, not asserted on: each look in a message and on the
// card, at 100% and 200%. One sheet a test: all seven in one opened the page
// seven times and took up to 15 seconds on CI, and under load ran out of its
// 30 (#528).
for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const [label, look, face] of LOOKS) {
      test(`review sheet: ${label}`, async ({ page }) => {
        await open(page, eliIn(look, face));
        await openCard(page);
        const [from, to] = [await inChat(page).boundingBox(), await card(page).boundingBox()];
        if (!from || !to) throw new Error("nothing to shoot");
        const x = Math.max(0, Math.min(from.x, to.x) - 16);
        const y = Math.max(0, Math.min(from.y, to.y) - 16);
        const project = test.info().project.name;
        await page.screenshot({
          path: `${SHEETS}/${project}-${scale * 100}-${label.replace(/ /g, "-")}.png`,
          clip: { x, y, width: Math.max(from.x + from.width, to.x + to.width) + 16 - x, height: Math.max(from.y + from.height, to.y + to.height) + 16 - y },
          animations: "disabled",
        });
      });
    }
  });
}
