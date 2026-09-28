import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Style } from "../../src/generated/Style";
import type { User } from "../../src/generated/User";
import { people } from "../fixtures/next/evening";

// Somebody offline has their name drawn in a dim grey in the list window,
// with none of their color, gradient, glow or shimmer, and gets it all back
// the moment they're here, away or idle again (#274). Their face stays, and
// so does the row's geometry. Driven in the real list window
// (tests/fixtures/next-list-window.tsx), with people restyled and moved on
// and off line by gateway frames, as a server would.
//
// The new client has one theme (dark); a light one is an open decision
// (docs/design/system.md, "Tokens"), so there is no second theme to test.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const SHEETS = "test-results/offline-names";

type Look = Pick<Style, "fill" | "effect">;

const SOLID: Style["fill"] = { kind: "solid", color: "lime" };
const GRADIENT: Style["fill"] = { kind: "gradient", from: "violet", to: "sky" };

const LOOKS: [string, Look][] = [
  ["a solid color", { fill: SOLID, effect: "none" }],
  ["a gradient", { fill: GRADIENT, effect: "none" }],
  ["a solid color with a glow", { fill: SOLID, effect: "glow" }],
  ["a gradient with a glow", { fill: GRADIENT, effect: "glow" }],
  ["a solid color with a shimmer", { fill: SOLID, effect: "shimmer" }],
  ["a gradient with a shimmer", { fill: GRADIENT, effect: "shimmer" }],
];

const styled = (user: User, look: Look): User => ({ ...user, style: { ...user.style, ...look } });

async function open(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect(rows(page, "People here").first()).toBeVisible();
}

const restyle = (page: Page, user: User) => page.evaluate(([server, d]) => window.core?.frame(server, { op: "user.update", d } as never), [HOME, user] as const);

/** Somebody's presence changes, as the server says it. */
const move = (page: Page, user: string, state: string, room: string | null = null, away: string | null = null) =>
  page.evaluate(
    ([server, user_id, state, room_id, away_message]) => window.core?.frame(server, { op: "presence.update", d: { user_id, state, room_id, away_message } } as never),
    [HOME, user, state, room, away] as const,
  );

const rows = (page: Page, list: string) => page.getByRole("list", { name: list, exact: true }).locator(":scope > li");
const nameIn = (page: Page, list: string, who: string) => rows(page, list).filter({ hasText: who }).locator("[data-kit='Name']");

async function showOffline(page: Page) {
  const toggle = page.getByRole("button", { name: /^Offline/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("list", { name: "Offline", exact: true })).toBeVisible();
}

interface Painted {
  color: string;
  fill: string;
  image: string;
  filter: string;
  shadow: string;
  animation: string;
  font: string;
  weight: string;
  slant: string;
}

/** How a name is painted, as the engine computed it. */
const paint = (name: Locator): Promise<Painted> =>
  name.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      color: s.color,
      fill: s.getPropertyValue("-webkit-text-fill-color"),
      image: s.backgroundImage,
      filter: s.filter,
      shadow: s.textShadow,
      animation: s.animationName,
      font: s.fontFamily,
      weight: s.fontWeight,
      slant: s.fontStyle,
    };
  });

/** A color as the page computes it: a token (`--text-offline`) or a system color (`GrayText`). */
const computed = (page: Page, value: string) =>
  page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value.startsWith("--") ? `var(${value})` : value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, value);

/** The dim, flat look: the token's color and nothing else. */
async function expectDim(page: Page, name: Locator, color?: string) {
  const want = color ?? (await computed(page, "--text-offline"));
  await expect.poll(async () => (await paint(name)).color).toBe(want);
  const now = await paint(name);
  expect(now.fill).toBe(want);
  expect(now.image).toBe("none");
  expect(now.filter).toBe("none");
  expect(now.shadow).toBe("none");
  expect(now.animation).toBe("none");
}

/**
 * Their own look: their colors, and the gradient, glow or shimmer they chose.
 * A gradient or a shimmer is painted by the background through the letters,
 * which are then see-through; anything else is the letters' own color.
 */
async function expectTheirs(page: Page, name: Locator, look: Look) {
  const [first, second] = look.fill.kind === "solid" ? [look.fill.color, look.fill.color] : [look.fill.from, look.fill.to];
  const [from, to] = [await computed(page, `--name-${first}`), await computed(page, `--name-${second}`)];
  const throughLetters = look.fill.kind === "gradient" || look.effect === "shimmer";
  await expect.poll(async () => (await paint(name)).color).toBe(throughLetters ? "rgba(0, 0, 0, 0)" : from);
  const now = await paint(name);
  if (throughLetters) {
    expect(now.image).toContain("linear-gradient");
    expect(now.image).toContain(from);
    expect(now.image).toContain(to);
  } else expect(now.image).toBe("none");
  if (look.effect === "glow") expect(now.filter).toContain(`drop-shadow(${from}`);
  else expect(now.filter).toBe("none");
  expect(now.animation).toBe(look.effect === "shimmer" ? "k-name-shimmer" : "none");
}

// --- Reading pixels --------------------------------------------------------

type Rgb = [number, number, number];

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** OKLab chroma: how far a color is from grey (a palette color is 0.1 or more). */
function chroma([r, g, b]: Rgb): number {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

/** Every pixel's color in and beside a name (sideways by the reach of a glow), and the token's. */
async function pixelsAround(page: Page, name: Locator): Promise<{ pixels: Rgb[]; token: Rgb }> {
  const box = await name.boundingBox();
  if (!box) throw new Error("no name to shoot");
  const reach = 8;
  const png = await page.screenshot({ clip: { x: box.x - reach, y: box.y, width: box.width + 2 * reach, height: box.height }, animations: "disabled" });
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const pixels: Rgb[] = [];
    for (let i = 0; i < data.length; i += 4) pixels.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
    const probe = document.createElement("div");
    probe.style.background = "var(--text-offline)";
    document.body.append(probe);
    context.fillStyle = getComputedStyle(probe).backgroundColor;
    probe.remove();
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { pixels, token: [r ?? 0, g ?? 0, b ?? 0] as Rgb };
  }, png.toString("base64"));
}

/**
 * The average tint of the ink in a patch, as how far red sits from green and
 * green from blue: a grey has almost none, a colored name a lot. Only pixels
 * clearly off the background count, so the empty space around the letters
 * doesn't water it down.
 */
function tintOf(pixels: Rgb[]): number[] {
  const background = pixels.reduce((dark, pixel) => (pixel[0] + pixel[1] + pixel[2] < dark[0] + dark[1] + dark[2] ? pixel : dark), pixels[0] ?? [0, 0, 0]);
  const ink = pixels.length === 1 ? pixels : pixels.filter((pixel) => pixel.reduce((sum, v, i) => sum + Math.abs(v - (background[i] ?? 0)), 0) > 60);
  const n = Math.max(ink.length, 1);
  return [ink.reduce((sum, p) => sum + (p[0] - p[1]), 0) / n, ink.reduce((sum, p) => sum + (p[1] - p[2]), 0) / n];
}

// --- The tests -------------------------------------------------------------

test.describe("an offline name is drawn in the dim grey, with none of their look (#274)", () => {
  // Measured at 200%, so the letters have whole pixels of their own color.
  test.use({ deviceScaleFactor: 2 });

  for (const [label, look] of LOOKS) {
    test(label, async ({ page }) => {
      await open(page);
      // Jen is offline; Eli is in #general. Both wear the same look.
      await restyle(page, styled(people.jen, look));
      await restyle(page, styled(people.eli, look));
      await showOffline(page);
      const jen = nameIn(page, "Offline", "Jen");
      const eli = nameIn(page, "People here", "Eli");
      await expectDim(page, jen);
      await expectTheirs(page, eli, look);
      await page.mouse.move(0, 0);

      // What's painted: every pixel in and beside the name is grey, and the
      // letters are the token's grey. No palette color, gradient or glow
      // shows anywhere.
      const { pixels, token } = await pixelsAround(page, jen);
      const colored = Math.max(...pixels.map(chroma));
      expect(colored, "the most colorful pixel in and beside the name").toBeLessThan(chroma(token) + 0.02);
      const lightest = pixels.reduce((best, pixel) => (pixel[0] + pixel[1] + pixel[2] > best[0] + best[1] + best[2] ? pixel : best));
      lightest.forEach((channel, i) => expect(Math.abs(channel - (token[i] ?? 0)), `the letters are ${token.join(",")}, not ${lightest.join(",")}`).toBeLessThanOrEqual(6));

      // The same pixels around Eli carry his color, so the check can fail.
      const his = await pixelsAround(page, eli);
      expect(Math.max(...his.pixels.map(chroma))).toBeGreaterThan(0.08);
    });
  }
});

// Only somebody here has the lights on (#301): idle and away are home with
// the lights off, so their names are the dim grey too, and only around or a
// room brings their look back.
test("only somebody here wears their look: idle, away and offline take it away, around or a room brings it back (#301)", async ({ page }) => {
  await open(page);
  const look: Look = { fill: { kind: "gradient", from: "violet", to: "orchid" }, effect: "glow" };
  await restyle(page, styled(people.callie, look));
  await showOffline(page);
  const here = nameIn(page, "People here", "Callie");
  await expectTheirs(page, here, look);
  const face = await paint(here);

  // Gone: the Offline group, dim and flat, in the same face.
  await move(page, people.callie.id, "offline");
  const gone = nameIn(page, "Offline", "Callie");
  await expect(gone).toBeVisible();
  await expectDim(page, gone);
  const dimmed = await paint(gone);
  expect([dimmed.font, dimmed.weight, dimmed.slant]).toEqual([face.font, face.weight, face.slant]);

  // Back, around: their look again, the moment the frame lands.
  await move(page, people.callie.id, "around");
  await expect(rows(page, "Offline").filter({ hasText: "Callie" })).toHaveCount(0);
  await expectTheirs(page, nameIn(page, "People here", "Callie"), look);

  // Away and idle are the lights off: dim, in the same face.
  await move(page, people.callie.id, "away", null, "out for a walk");
  const away = nameIn(page, "Away", "Callie");
  await expectDim(page, away);
  expect((await paint(away)).font).toBe(face.font);
  await move(page, people.callie.id, "idle");
  await expectDim(page, nameIn(page, "People here", "Callie"));

  // Around again, then offline once more, then into a room.
  await move(page, people.callie.id, "around");
  await expectTheirs(page, nameIn(page, "People here", "Callie"), look);
  await move(page, people.callie.id, "offline");
  await expectDim(page, nameIn(page, "Offline", "Callie"));
  await move(page, people.callie.id, "in_room", "r-general");
  await expectTheirs(page, nameIn(page, "People here", "Callie"), look);
});

test.describe("an idle or away name is the dim grey, glow and all, and an away message keeps its warm color (#301)", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const [state, list] of [["idle", "People here"], ["away", "Away"]] as const) {
    test(state, async ({ page }) => {
      await open(page);
      // Callie, who isn't in voice: nothing colorful is drawn after her name,
      // so every colored pixel near it would be hers.
      const look: Look = { fill: SOLID, effect: "glow" };
      await restyle(page, styled(people.callie, look));
      await move(page, people.callie.id, state, null, state === "away" ? "back after lunch" : null);
      const callie = nameIn(page, list, "Callie");
      await expectDim(page, callie);
      await page.mouse.move(0, 0);
      // What's painted, read as the letters' overall tint. Chromium on CI
      // smooths text with colored fringes (blue on one edge of a letter,
      // orange on the other), so a single pixel can look colorful even on
      // grey letters; the fringes cancel out over a name, and her lime
      // wouldn't. The dim letters are tinted like the grey token, not like her.
      const dim = await pixelsAround(page, callie);
      await move(page, people.callie.id, "around");
      const lit = await pixelsAround(page, nameIn(page, "People here", "Callie"));
      const away = (from: number[], to: number[]) => Math.hypot(...from.map((v, i) => v - (to[i] ?? 0)));
      const [dimTint, litTint, greyTint] = [tintOf(dim.pixels), tintOf(lit.pixels), tintOf([dim.token])];
      expect(away(litTint, greyTint), "her own color shows when she's around").toBeGreaterThan(30);
      expect(away(dimTint, greyTint), "the dim letters are tinted like the grey, not like her").toBeLessThan(away(litTint, greyTint) * 0.25);
      if (state === "away") {
        await move(page, people.callie.id, "away", null, "back after lunch");
        const note = rows(page, "Away").filter({ hasText: "Callie" }).locator(".k-row-detail");
        await expect(note).toHaveText("back after lunch");
        expect(await note.evaluate((node) => getComputedStyle(node).color)).toBe(await computed(page, "--text-away"));
      }
    });
  }
});

test("with plain names on, an offline name is still the dim grey, and everybody else plain", async ({ page }) => {
  await open(page);
  const look: Look = { fill: GRADIENT, effect: "shimmer" };
  await restyle(page, styled(people.jen, look));
  await restyle(page, styled(people.eli, look));
  await showOffline(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-normalize", "true"));
  const jen = nameIn(page, "Offline", "Jen");
  const eli = nameIn(page, "People here", "Eli");
  await expectDim(page, jen);
  // Plain, not dim: the reader's own default, in the default face.
  await expectDim(page, eli, await computed(page, "--text-primary"));
  expect((await paint(jen)).font).toBe((await paint(eli)).font);
});

test("in high contrast, an offline name takes the system's color for dim text", async ({ page }) => {
  await open(page);
  const look: Look = { fill: GRADIENT, effect: "glow" };
  await restyle(page, styled(people.jen, look));
  await restyle(page, styled(people.eli, look));
  await showOffline(page);
  await page.emulateMedia({ forcedColors: "active" });
  const jen = nameIn(page, "Offline", "Jen");
  await expect.poll(async () => (await paint(jen)).color).toBe(await computed(page, "GrayText"));
  const now = await paint(jen);
  expect(now.fill).toBe(now.color);
  expect(now.image).toBe("none");
  expect(now.filter).toBe("none");
  // Everybody else's name is repainted by the system itself, in its text
  // color. That is the engine's doing, not ours: Chromium does it, while
  // WebKit only answers the media query and repaints nothing, so it isn't
  // checked here.
});

// The dim name changes nothing about the row: every person's row is 48px,
// every name starts on one edge, in a 20px line at the same height in its
// row, whichever group it's in, at 100% and 200%. A sheet of the People
// section with the Offline group open is saved for a person to look at.
for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale });
    test("offline rows line up with everybody else's, and keep their height", async ({ page }) => {
      await open(page);
      // Some look on both sides: here, Eli glows and Dave shimmers; offline,
      // Jen glows and Callie (gone too) shimmers across a gradient.
      await restyle(page, styled(people.eli, { fill: { kind: "solid", color: "amber" }, effect: "glow" }));
      await restyle(page, styled(people.dave, { fill: { kind: "solid", color: "cyan" }, effect: "shimmer" }));
      await restyle(page, styled(people.jen, { fill: SOLID, effect: "glow" }));
      await restyle(page, styled(people.callie, { fill: { kind: "gradient", from: "violet", to: "orchid" }, effect: "shimmer" }));
      await move(page, people.callie.id, "offline");
      await showOffline(page);
      await expect(rows(page, "Offline")).toHaveCount(2);
      await expectDim(page, nameIn(page, "Offline", "Callie"));

      const measured = await page
        .locator("[data-screen='list'] ul[aria-label='People here'] > li, [data-screen='list'] ul[aria-label='Away'] > li, [data-screen='list'] ul[aria-label='Offline'] > li")
        .evaluateAll((items) =>
          items.map((item) => {
            const row = item.getBoundingClientRect();
            const name = item.querySelector("[data-kit='Name']")?.getBoundingClientRect();
            return {
              who: item.textContent,
              offline: item.closest("ul")?.getAttribute("aria-label") === "Offline",
              height: row.height,
              x: name?.x ?? -1,
              top: (name?.y ?? -1) - row.y,
              line: name?.height ?? -1,
            };
          }),
        );
      expect(measured.filter((row) => row.offline)).toHaveLength(2);
      expect(measured.filter((row) => !row.offline).length).toBeGreaterThan(3);
      expect(new Set(measured.map((row) => row.height)), JSON.stringify(measured)).toEqual(new Set([48]));
      expect(new Set(measured.map((row) => row.x)).size, JSON.stringify(measured)).toBe(1);
      expect(new Set(measured.map((row) => row.top)).size, JSON.stringify(measured)).toBe(1);
      expect(new Set(measured.map((row) => row.line)), JSON.stringify(measured)).toEqual(new Set([20]));

      // The sheet: from the People heading to the last offline row.
      await page.mouse.move(0, 0);
      const heading = page.locator("[data-kit='SectionLabel']", { hasText: "People" }).first();
      await heading.scrollIntoViewIfNeeded();
      const [top, bottom] = [await heading.boundingBox(), await rows(page, "Offline").last().boundingBox()];
      if (!top || !bottom) throw new Error("nothing to shoot");
      await page.screenshot({
        path: `${SHEETS}/${test.info().project.name}-${scale * 100}.png`,
        clip: { x: 0, y: top.y, width: 340, height: bottom.y + bottom.height + 8 - top.y },
        animations: "disabled",
      });
    });
  });
}
