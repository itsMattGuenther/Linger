import { expect, type Locator, type Page, test } from "@playwright/test";
import { finger, hoverOnly, iPhoneTaps, middle, noLongPress, spread } from "./finger";
import { still } from "./still";

// The phone app (SPEC §4.15): the same list window, opened as the phone's one
// window (`?shell=phone`, core/phone.ts), at a phone's size. Nothing on it may
// need a second window, and nothing desktop-only is offered.

test.use({ viewport: { width: 411, height: 914 } });

async function open(page: Page, query: string) {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** Every connection the page opened has had its `ready` (next-side.spec.ts says why, #355). */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
}

/** The phone, signed in to one server, with everything it asked for in. */
async function phone(page: Page) {
  await open(page, "?one&shell=phone");
  await settled(page);
}

const list = (page: Page) => page.locator("[data-screen='list']");
const screen = (page: Page) => page.locator("[data-screen='chat']");
const title = (page: Page) => screen(page).locator(".k-titlebar");
const back = (page: Page) => screen(page).getByRole("button", { name: "Back", exact: true });
const room = (page: Page, name: string) => page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: new RegExp(`^#${name}\\b`) });

/** What an iPhone's web view says it is (core/phone.ts, `isIPhone`): the page swipes back itself (#697). */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
/** What Android's says: Back is the phone's own. */
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

/**
 * A finger from `from` to `to`, 10 pixels at a time, slowly enough never to
 * be a flick (core/edgeSwipe.ts), and lifted unless `lift` is false.
 * Chromium only (finger.ts).
 */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, lift = true) {
  const touch = await finger(page);
  await touch.down(from);
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 10);
  for (let step = 1; step <= steps; step += 1) {
    await touch.move({ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps });
    await page.waitForTimeout(40);
  }
  if (lift) await touch.up();
  return touch;
}

/** How far right of its place something is drawn, by its transform: an iPhone's swipe back moves the screen (#697). */
const over = (of: Locator) => of.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41);

/**
 * What reaches past the right edge of the screen: a page that scrolls
 * sideways, or anything drawn wider than the phone, words cut off at the
 * edge included. A line that ends in "…" is fine as long as the line itself
 * fits: its words run on inside it, but the "…" shows. Things parked off the
 * screen on purpose sit wholly past the edge, and anything inside them is
 * theirs.
 */
async function sticksOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    const out: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > edge) out.push(`the page scrolls sideways: ${root.scrollWidth} is wider than ${edge}`);
    for (const element of document.body.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right <= edge + 0.5) continue;
      if (getComputedStyle(element).visibility === "hidden") continue;
      let parked = box.left >= edge;
      let ellipsis = false;
      for (let up = element.parentElement; up && !parked && !ellipsis; up = up.parentElement) {
        const around = up.getBoundingClientRect();
        const style = getComputedStyle(up);
        parked = around.left >= edge;
        // Cut with a "…" by a line that fits: the "…" is on the screen.
        ellipsis = style.overflowX !== "visible" && style.textOverflow === "ellipsis" && around.right <= edge + 0.5;
      }
      if (parked || ellipsis) continue;
      const name = [element.tagName.toLowerCase(), ...element.classList].join(".");
      out.push(`${name} ends at ${Math.round(box.right)}, past ${edge}: "${(element.textContent ?? "").trim().slice(0, 40)}"`);
    }
    // A box that scrolls sideways inside the screen is a conversation that
    // drags sideways too (#688), though nothing in it passes the edge.
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      const name = [element.tagName.toLowerCase(), ...element.classList].join(".");
      out.push(`${name} scrolls sideways: ${element.scrollWidth} is wider than ${element.clientWidth}`);
    }
    return out;
  });
}

test("has no close button of its own: a phone's app is closed the phone's way", async ({ page }) => {
  await open(page, "");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toBeVisible();
  await open(page, "?shell=phone");
  await expect(page.locator("[data-screen='list']").getByRole("button", { name: "Close window" })).toHaveCount(0);
});

test("opens Settings over the list, as its sections and then one section, without asking for a window", async ({ page }) => {
  // A computer asks the shell for Settings' own window.
  await open(page, "");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => (await did(page)).some((line) => line.startsWith("next_open_settings"))).toBe(true);
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);

  await open(page, "?shell=phone");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  await expect(settings).toBeVisible();
  expect((await did(page)).some((line) => line.includes("next_open_settings"))).toBe(false);

  // The sections first, the whole width: nothing a phone doesn't have.
  const sections = settings.getByRole("navigation", { name: "Settings" });
  await expect(sections).toBeVisible();
  await expect(settings.locator(".nx-set-main")).toBeHidden();
  await expect(sections).toContainText("Profile");
  await expect(sections).toContainText("Sound");
  await expect(sections).not.toContainText("Windows");
  await expect(sections).not.toContainText("Notifications");
  await expect(sections).not.toContainText("Voice");

  // One section, the whole width, with the way back.
  await sections.getByText("Appearance").click();
  await expect(sections).toBeHidden();
  await expect(settings.locator(".nx-set-title")).toHaveText("Appearance");
  // A phone sizes things with its own display and text size: no Interface
  // size, which couldn't zoom the phone's window anyway.
  await expect(settings.getByText("Use plain names and message fonts", { exact: true })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Interface size" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Back to Settings" }).click();
  await expect(sections).toBeVisible();

  // Back is the list again, as on every phone screen: no window to close.
  await expect(settings.getByRole("button", { name: "Close window" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".nx-phone-over")).toHaveCount(0);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
});

test("Account & App says which version this is, under This Phone, and never looks for an update", async ({ page }) => {
  await phone(page);
  await list(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  await settings.getByRole("navigation", { name: "Settings" }).getByText("Account & App").click();
  await expect(settings.locator(".nx-set-title")).toHaveText("Account & App");
  // A phone has no Updates of its own, so its version goes with This Phone:
  // installing a newer release by hand starts with knowing this one (SPEC §4.15).
  const thisPhone = settings.getByRole("region", { name: "This Phone" });
  await expect(thisPhone.getByText("You're on version 0.3.6.", { exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Updates" })).toHaveCount(0);
  expect(await did(page)).not.toContain("update_check");
});

/**
 * Words cut off top or bottom: a box that hides what doesn't fit, holding
 * words of its own, with more of them than it shows. That was a name at
 * twice the size in a row drawn for the usual one, showing 20px of 40
 * (2026-10-03). Boxes that scroll are left out; scrolling is how they show
 * the rest.
 */
async function cutOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      if (style.overflowY !== "hidden" && style.overflowY !== "clip") continue;
      // Labels only a screen reader reads are 1px boxes on purpose.
      if (style.visibility === "hidden" || element.clientHeight <= 1) continue;
      const words = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      // A font's padding above and below its letters can poke a few pixels
      // past a line drawn as tall as the letters, which shows nothing; a fifth
      // more than the box is words cut off.
      if (!words || element.scrollHeight <= element.clientHeight * 1.2 + 1) continue;
      out.push(`${[element.tagName.toLowerCase(), ...element.classList].join(".")} shows ${element.clientHeight}px of ${element.scrollHeight}: "${(element.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out;
  });
}

test("a room opens as the whole screen, with Back to the list and no tabs", async ({ page }) => {
  await phone(page);
  await room(page, "general").click();
  await expect(screen(page)).toBeVisible();
  await expect(list(page)).toBeHidden();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");

  // The bar is the way back and the room's name: no tab strip, nothing to
  // fold or pop out (SPEC §4.15).
  await expect(title(page)).toContainText("general");
  await expect(screen(page).getByRole("tablist")).toHaveCount(0);
  await expect(screen(page).getByRole("button", { name: "Fold back to your list" })).toHaveCount(0);
  await expect(screen(page).getByRole("button", { name: "Open in its own window" })).toHaveCount(0);

  await back(page).click();
  await expect(list(page)).toBeVisible();
  await expect(screen(page)).toHaveCount(0);
  // Nothing was left behind to unfold again.
  await expect(page.getByRole("button", { name: "Show your conversations" })).toHaveCount(0);

  // A computer keeps its tabs beside the list, as before.
  await open(page, "?one");
  await settled(page);
  await room(page, "general").click();
  await expect(page.getByRole("tab", { name: "#general", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
});

test("screens stack: a search hit opens over Search, and Back goes back down through them", async ({ page }) => {
  await phone(page);
  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(title(page)).toHaveText("Search");
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("moon");
  await page.locator(".nx-hit-main").first().click();
  await expect(title(page)).toContainText("general");
  await expect(page.getByRole("log")).toContainText("that's the moon");

  await back(page).click();
  await expect(title(page)).toHaveText("Search");
  // As it was left, and without the cursor in the box: on a phone that
  // would bring the keyboard up, and the next Back would only lower it.
  const words = page.getByRole("textbox", { name: "Search", exact: true });
  await expect(words).toHaveValue("moon");
  await expect(page.locator(".nx-hit-main").first()).toBeVisible();
  await expect(words).not.toBeFocused();
  await back(page).click();
  await expect(list(page)).toBeVisible();
  await expect(screen(page)).toHaveCount(0);

  // Opened again from the list, Search starts fresh.
  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(words).toHaveValue("");
  await back(page).click();

  // Media opens the same way, straight over the list again.
  await list(page).getByRole("button", { name: "Media", exact: true }).click();
  await expect(title(page)).toHaveText("Media");
  await back(page).click();
  await expect(list(page)).toBeVisible();
});

test("nothing reaches past the edge of the phone's screen, on any screen", async ({ page }) => {
  await phone(page);
  expect(await sticksOut(page), "the list").toEqual([]);

  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  expect(await sticksOut(page), "a room").toEqual([]);
  await back(page).click();

  await page.getByRole("list", { name: "People here" }).getByRole("button", { name: /^Jules/ }).first().click();
  await expect(title(page)).toContainText("Jules");
  expect(await sticksOut(page), "a DM").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Media", exact: true }).click();
  await expect(screen(page).locator(".nx-pane-other")).toBeVisible();
  expect(await sticksOut(page), "Media").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("porch");
  await expect(page.locator(".nx-hit-main").first()).toBeVisible();
  expect(await sticksOut(page), "Search").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  const sections = settings.getByRole("navigation", { name: "Settings" });
  await expect(sections).toBeVisible();
  expect(await sticksOut(page), "Settings").toEqual([]);
  const names = (await sections.getByRole("tab").allTextContents()).map((name) => name.trim());
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) {
    await sections.getByRole("tab", { name, exact: true }).click();
    await expect(settings.locator(".nx-set-title")).toHaveText(name);
    expect(await sticksOut(page), `Settings, ${name}`).toEqual([]);
    await settings.getByRole("button", { name: "Back to Settings" }).click();
  }
});

test("at the phone's largest text size, words fit their lines and nothing reaches past the edge", async ({ page }) => {
  await phone(page);
  // What followTextSize sets from the phone's Font size at its largest
  // (core/phone.ts): text, lines, rows and controls all grow together.
  await page.evaluate(() => document.documentElement.style.setProperty("--text-scale", "2"));
  expect(await cutOff(page), "the list").toEqual([]);
  expect(await sticksOut(page), "the list").toEqual([]);

  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  expect(await cutOff(page), "a room").toEqual([]);
  expect(await sticksOut(page), "a room").toEqual([]);
  await back(page).click();

  await list(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".nx-phone-over [data-screen='settings']");
  const sections = settings.getByRole("navigation", { name: "Settings" });
  for (const name of (await sections.getByRole("tab").allTextContents()).map((one) => one.trim())) {
    await sections.getByRole("tab", { name, exact: true }).click();
    expect(await cutOff(page), `Settings, ${name}`).toEqual([]);
    expect(await sticksOut(page), `Settings, ${name}`).toEqual([]);
    await settings.getByRole("button", { name: "Back to Settings" }).click();
  }
});

// The phone app doesn't zoom (#689): its text gets bigger by the phone's
// text size, and a zoomed screen is only wider than the phone, dragging
// sideways. The same limit stops an iPhone zooming in on a text box whose
// words are under 16px when it gets the cursor, and not always zooming back
// out: the conversation sat shifted left after typing (#688). Playwright's
// WebKit doesn't do that zoom, so the viewport's words are the proof of it.
// This is the app's own page, as the phone opens it, not a fixture.
test.describe("the phone's page never zooms (#689, #688)", () => {
  test.use({ isMobile: true, hasTouch: true });

  test("its viewport forbids zoom, which also keeps an iPhone from zooming in on the message box", async ({ page }) => {
    await page.goto("/next.html?shell=phone");
    const content = (await page.locator("meta[name='viewport']").getAttribute("content")) ?? "";
    const said = new Map(content.split(",").map((part): [string, string] => {
      const [key = "", value = ""] = part.split("=").map((side) => side.trim());
      return [key, value];
    }));
    expect(said.get("width")).toBe("device-width");
    expect(Number(said.get("initial-scale"))).toBe(1);
    expect(Number(said.get("maximum-scale"))).toBe(1);
    expect(said.get("user-scalable")).toBe("no");
    expect(said.get("viewport-fit")).toBe("cover");
  });

  test("two fingers spread apart zoom nothing", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Only Chromium lets a test put two fingers down");
    await page.goto("/next.html?shell=phone");
    await expect(page.locator("#root *").first()).toBeVisible();
    await spread(page, { x: 205, y: 450 });
    // A pinch that zoomed would have the screen show part of the page,
    // moved off its left edge (it reached 5 times, 2026-10-21).
    const seen = await page.evaluate(() => ({ scale: window.visualViewport?.scale, left: window.visualViewport?.offsetLeft, width: window.visualViewport?.width }));
    expect(seen).toEqual({ scale: 1, left: 0, width: 411 });
  });
});

// The page never zooms, so a photo opened from a message zooms itself, as
// a phone's own photo viewer does (core/zoom.ts): pinched, dragged, and
// double-tapped in and out. A tap closes it only while it isn't zoomed.
test.describe("a photo opened from a message zooms under your fingers (#689)", () => {
  test.use({ isMobile: true, hasTouch: true });

  /** A room with a photo 800×500 in it, opened in its viewer: the picture, and its size there. */
  async function openPhoto(page: Page) {
    await phone(page);
    await room(page, "general").click();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    await page.route("https://good-company.example/media/porch-zoom*", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#445"/><rect x="380" y="230" width="40" height="40" fill="#ffcf7a"/></svg>' }),
    );
    await page.evaluate(() => {
      const url = "/media/porch-zoom";
      const attachment = { id: "a-porch", filename: "porch.png", mime: "image/png", size_bytes: 1_000, url, display_url: url, width: 800, height: 500, duration_ms: null, blurhash: null, poster_url: null, starred_at: null, uploader_id: "u-eli", created_at: Date.now() };
      const d = { id: "m900002", room_id: "r-general", author_id: "u-eli", body: "the porch tonight", reply_to: null, attachments: [attachment], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: new Date().toISOString() };
      window.core?.frame("https://good-company.example", { op: "message.create", d } as never);
    });
    await page.getByRole("button", { name: "Open porch.png" }).tap();
    const viewer = page.getByRole("dialog", { name: "porch.png" });
    const picture = viewer.locator("img");
    await expect.poll(() => picture.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    const opened = await picture.boundingBox();
    if (!opened) throw new Error("no picture on the screen");
    return { viewer, picture, opened };
  }

  /** How many times wider the picture is drawn than it opened, once it stops gliding. */
  const zoomedBy = async (picture: Locator, opened: { width: number }) => ((await picture.boundingBox())?.width ?? 0) / opened.width;
  const pageScale = (page: Page) => page.evaluate(() => window.visualViewport?.scale);
  const doubleTap = async (page: Page, at: { x: number; y: number }) => {
    await page.touchscreen.tap(at.x, at.y);
    await page.touchscreen.tap(at.x, at.y);
  };

  test("two fingers zoom the photo and not the page, one drags it, and a tap while zoomed closes nothing", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Only Chromium lets a test put two fingers down");
    const { viewer, picture, opened } = await openPhoto(page);
    const center = { x: opened.x + opened.width / 2, y: opened.y + opened.height / 2 };

    // Spread six times apart: as far as it zooms, four times.
    await spread(page, center);
    await expect.poll(() => zoomedBy(picture, opened)).toBeCloseTo(4, 1);
    expect(await pageScale(page)).toBe(1);
    // What was between the fingers is still there: the middle of the picture.
    const zoomed = await picture.boundingBox();
    expect(Math.abs((zoomed?.x ?? 0) + (zoomed?.width ?? 0) / 2 - center.x)).toBeLessThan(2);

    const hand = await finger(page);
    await hand.down(center);
    for (let step = 1; step <= 10; step += 1) await hand.move({ x: center.x - step * 10, y: center.y });
    await hand.up();
    await expect.poll(async () => (await picture.boundingBox())?.x).toBeCloseTo((zoomed?.x ?? 0) - 100, 0);

    // A tap while looking around keeps the photo open.
    await page.touchscreen.tap(center.x, center.y);
    await page.waitForTimeout(600);
    await expect(viewer).toBeVisible();
    expect(await pageScale(page)).toBe(1);
  });

  test("a double tap zooms in on the photo and the next zooms back out; a tap then closes it", async ({ page }) => {
    const { viewer, picture, opened } = await openPhoto(page);
    const center = { x: opened.x + opened.width / 2, y: opened.y + opened.height / 2 };

    await doubleTap(page, center);
    await expect.poll(() => zoomedBy(picture, opened)).toBeCloseTo(2.5, 1);
    await page.waitForTimeout(600);
    await expect(viewer).toBeVisible();

    await doubleTap(page, center);
    await expect.poll(() => zoomedBy(picture, opened)).toBeCloseTo(1, 2);
    await expect.poll(async () => (await picture.boundingBox())?.x).toBeCloseTo(opened.x, 0);
    await expect(viewer).toBeVisible();

    await page.touchscreen.tap(center.x, center.y);
    await expect(viewer).toHaveCount(0);
    expect(await pageScale(page)).toBe(1);
  });

  // An iPhone's swipe back closes a photo as Back does, the conversation
  // under it, but a finger on a zoomed one is the photo's own.
  test.describe("on an iPhone (#697)", () => {
    test.use({ userAgent: IPHONE });
    test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test put a finger down and move it");

    test("zoomed, a finger from the left edge drags the photo; not zoomed, it slides the photo off and closes it", async ({ page }) => {
      const { viewer, picture, opened } = await openPhoto(page);
      const center = { x: opened.x + opened.width / 2, y: opened.y + opened.height / 2 };
      await spread(page, center);
      await expect.poll(() => zoomedBy(picture, opened)).toBeCloseTo(4, 1);
      const zoomed = await picture.boundingBox();

      await drag(page, { x: 4, y: center.y }, { x: 204, y: center.y });
      await expect.poll(async () => (await picture.boundingBox())?.x).toBeCloseTo((zoomed?.x ?? 0) + 200, 0);
      await expect(viewer).toBeVisible();
      expect(await over(viewer)).toBe(0);

      await doubleTap(page, center);
      await expect.poll(() => zoomedBy(picture, opened)).toBeCloseTo(1, 2);
      const touch = await drag(page, { x: 4, y: center.y }, { x: 204, y: center.y }, false);
      await expect.poll(() => over(viewer)).toBeCloseTo(200, 0);
      await touch.up();
      await expect(viewer).toHaveCount(0);
      await expect(screen(page)).toBeVisible();
    });
  });
});

// The narrowest phones are 320 wide (#688). Nothing on the main screens may
// reach past the edge there either, nor with the message box in use, since
// testers saw the conversation drag sideways mostly after typing.
test.describe("on a phone 320 wide, the narrowest (#688)", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("nothing reaches past the edge on the main screens, typing in the message box included", async ({ page }) => {
    await phone(page);
    expect(await sticksOut(page), "the list").toEqual([]);

    await room(page, "general").click();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    expect(await sticksOut(page), "a room").toEqual([]);

    // A long message with a word that can't break, and a link.
    const long = "Supercalifragilisticexpialidociousandthensomemorewithoutaspace, see https://example.com/a/very/long/link/that/never/breaks/anywhere";
    await page.evaluate((body) => {
      const d = { id: "m900001", room_id: "r-general", author_id: "u-eli", body, reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: new Date().toISOString() };
      window.core?.frame("https://good-company.example", { op: "message.create", d } as never);
    }, long);
    await expect(page.getByRole("log")).toContainText("Supercalifragilistic");
    expect(await sticksOut(page), "a long message").toEqual([]);

    const box = page.getByRole("combobox", { name: /^Message/ });
    await box.click();
    await expect(box).toBeFocused();
    await box.pressSequentially("Running late, save me a seat https://example.com/a/very/long/link/that/never/breaks/anywhere/at/all");
    expect(await sticksOut(page), "typing in the message box").toEqual([]);

    // In voice: its controls in the room, then the bar on the list.
    await page.getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Join" }).click();
    await expect(page.getByRole("group", { name: "Your voice" }).first()).toBeVisible();
    expect(await sticksOut(page), "in voice").toEqual([]);
    await back(page).click();
    await expect(page.getByRole("region", { name: "In voice in #general" })).toBeVisible();
    expect(await sticksOut(page), "the list, in voice").toEqual([]);

    // Another room, with the line saying where your voice is.
    await room(page, "weekend-plans").click();
    await expect(screen(page).getByRole("group", { name: "Your voice call" })).toBeVisible();
    expect(await sticksOut(page), "another room, in voice").toEqual([]);
    await back(page).click();

    await page.getByRole("list", { name: "People here" }).getByRole("button", { name: /^Jules/ }).first().click();
    await expect(title(page)).toContainText("Jules");
    expect(await sticksOut(page), "a DM").toEqual([]);
    await back(page).click();

    await list(page).getByRole("button", { name: "Media", exact: true }).click();
    await expect(screen(page).locator(".nx-pane-other")).toBeVisible();
    expect(await sticksOut(page), "Media").toEqual([]);
    await back(page).click();

    await list(page).getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("porch");
    await expect(page.locator(".nx-hit-main").first()).toBeVisible();
    expect(await sticksOut(page), "Search").toEqual([]);
    await back(page).click();

    await list(page).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator(".nx-phone-over [data-screen='settings']");
    const sections = settings.getByRole("navigation", { name: "Settings" });
    await expect(sections).toBeVisible();
    expect(await sticksOut(page), "Settings").toEqual([]);
    for (const name of (await sections.getByRole("tab").allTextContents()).map((one) => one.trim())) {
      await sections.getByRole("tab", { name, exact: true }).click();
      await expect(settings.locator(".nx-set-title")).toHaveText(name);
      expect(await sticksOut(page), `Settings, ${name}`).toEqual([]);
      await settings.getByRole("button", { name: "Back to Settings" }).click();
    }
  });
});

// Report and block on the phone (T-1605): there's no hovering for a
// message's ···, so a message is held for its actions, which rise from the
// bottom; a report's form rises the same way. The computer's are in
// next-report-block.spec.ts.
test("holding a message opens its actions from the bottom, Report to host… last, and its form rises there too", async ({ page }) => {
  await open(page, "?one&guest&shell=phone");
  await settled(page);
  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  await page.locator(".nx-msg", { hasText: "No plans, no agenda" }).last().dispatchEvent("contextmenu");
  const sheet = page.getByRole("menu");
  // Its actions; the emoji above them are #485's, tested below.
  await expect(sheet.locator("[data-kit='MenuItem']")).toHaveText(["Reply", "Copy text", "Pin", "Report to host…"]);
  expect(await sticksOut(page), "the actions").toEqual([]);

  await sheet.getByRole("menuitem", { name: "Report to host…" }).click();
  const form = page.getByRole("dialog", { name: "Report Eli's message" });
  await expect(form).toContainText("It goes to Eli, who hosts this server, and to nobody else.");
  expect(await sticksOut(page), "the report").toEqual([]);
  await form.getByRole("button", { name: "Send to Eli" }).click();
  await expect(form.getByRole("status")).toContainText("Sent to Eli. Only Eli sees it.");
  await form.getByRole("button", { name: "Done" }).click();
  await expect(form).toHaveCount(0);
  expect((await did(page)).filter((line) => line.startsWith("report "))).toHaveLength(1);
});

test("the host's lit row opens People over the list, with the report in it", async ({ page }) => {
  await open(page, "?one&reports&shell=phone");
  await settled(page);
  const row = list(page).getByRole("button", { name: /A report to look at/ });
  await expect(row).toBeVisible();
  expect(await sticksOut(page), "the list").toEqual([]);
  await row.click();
  // Settings' list of them; the list underneath has its row in one named the same.
  const reports = page.locator("[data-screen='settings']").getByRole("list", { name: "Reports" });
  const report = reports.getByRole("listitem");
  await expect(report).toContainText("From Eli, about a message by Jules in #general");
  expect(await sticksOut(page), "People").toEqual([]);
  await report.getByRole("button", { name: "Let it go" }).click();
  await expect.poll(async () => did(page)).toContain("close r-1");
  await expect(reports).toHaveCount(0);
  // Back on the list (through Settings' own sections), the row has gone with the last report.
  await page.getByRole("button", { name: "Back to Settings" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(list(page).getByRole("button", { name: /A report to look at/ })).toHaveCount(0);
});

// A hint that wraps shows its second line cut off, and Android's engine
// doesn't cut a text box's hint with a "…": on a phone, a room with a long
// name had "Say something in #screenshots and" and a sliver of a second line.
test("the message box's hint fits on one line: who it's to when that fits, and just Say something when not", async ({ page }) => {
  await phone(page);
  await page.evaluate(() =>
    window.core?.frame("https://good-company.example", {
      op: "room.update",
      d: { id: "r-general", slug: "general", name: "screenshots and clips", topic: "Good company. No hurry.", kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: "m000016" },
    } as never),
  );
  await room(page, "screenshots and clips").click();
  const box = page.getByRole("combobox", { name: /^Message/ });
  await expect(box).toHaveAttribute("placeholder", "Say something");
  const oneLine = await box.evaluate((node: HTMLTextAreaElement) => {
    const style = getComputedStyle(node);
    return node.scrollHeight <= Math.ceil(parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)) + 1;
  });
  expect(oneLine).toBe(true);

  // A computer's window has room for the whole of it.
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page, "?one");
  await settled(page);
  await room(page, "general").click();
  await expect(page.getByRole("combobox", { name: /^Message/ })).toHaveAttribute("placeholder", "Say something in #general");
});

// Emoji on the phone (#359): the picker spans the message box, its emoji are
// a finger's size, and the keyboard stays down until Search is tapped, since
// it would cover half the picker.
test("the emoji picker spans the message box, its emoji a finger's size, and leaves the keyboard down", async ({ page }) => {
  await phone(page);
  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Emoji" });
  const first = picker.getByRole("region", { name: "Smileys & emotion" }).getByRole("button").first();
  await expect(first).toBeVisible();

  const cell = await first.boundingBox();
  expect(cell?.width).toBeGreaterThanOrEqual(44);
  expect(cell?.height).toBeGreaterThanOrEqual(44);
  const spans = await picker.boundingBox();
  const box = await page.locator(".nx-composer-box").boundingBox();
  // Inside the box's own border, to the pixel.
  expect(Math.abs((spans?.x ?? 0) - (box?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((spans?.x ?? 0) + (spans?.width ?? 0) - (box?.x ?? 0) - (box?.width ?? 0))).toBeLessThanOrEqual(1);
  await expect(picker.getByRole("searchbox", { name: "Find an emoji" })).toBeVisible();
  await expect(picker.getByRole("searchbox", { name: "Find an emoji" })).not.toBeFocused();
  expect(await sticksOut(page), "the emoji picker").toEqual([]);

  await first.click();
  await expect(page.getByRole("combobox", { name: /^Message/ })).toHaveValue(/^\p{Extended_Pictographic}/u);
});

// Reactions on the phone (#485): no hovering, so holding a message offers the
// six emoji you use most and every emoji, and the smiley-plus after a
// message's reactions is always there.
test("holding a message reacts with one of six, or any emoji from the picker at the bottom", async ({ page }) => {
  await open(page, "?one&guest&shell=phone");
  await settled(page);
  await room(page, "general").click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
  const row = page.locator(".nx-msg", { hasText: "No plans, no agenda" }).last();
  const id = (await row.getAttribute("data-message")) ?? "";
  await row.dispatchEvent("contextmenu");
  const quick = page.getByRole("menu").getByRole("group", { name: "React" });
  await expect(quick.getByRole("menuitem")).toHaveCount(7);
  await expect(quick.getByRole("menuitem").last()).toHaveAttribute("aria-label", "Every emoji");
  expect(await sticksOut(page), "the sheet").toEqual([]);
  await quick.getByRole("menuitem", { name: "❤️" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The server's word comes back as a frame, and the pill is yours.
  const pill = row.locator(".nx-react-pill").first();
  await expect(pill.locator(".nx-react-count")).toHaveText("1");
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  expect(await did(page)).toContain(`react ${id} ❤️ on`);

  // The smiley-plus is there without hovering, and opens every emoji.
  const add = row.getByRole("button", { name: "Add a reaction" });
  await expect(add).toHaveCSS("opacity", "1");
  await add.click();
  const picker = page.getByRole("dialog", { name: "React to Eli's message" });
  await expect(picker).toBeVisible();
  // The phone's keyboard waits for a tap, so it doesn't cover the picker.
  await expect(picker.getByRole("searchbox", { name: "Find an emoji" })).not.toBeFocused();
  expect(await sticksOut(page), "the picker").toEqual([]);
  const box = await picker.boundingBox();
  const view = page.viewportSize();
  expect(box && view && box.y + box.height).toBeGreaterThan((view?.height ?? 0) - 40);
});

// Held with a real finger (#686). The tests above hand the message the
// long-press Android's web view sends; an iPhone's sends none, so these take
// it away (finger.ts) and the hold is the page's own, timed as a reaction
// pill's is (#573).
test.describe("held with a finger, on an iPhone too", () => {
  test.use({ hasTouch: true });
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test hold a finger down");

  const message = (page: Page, words: string) => page.locator(".nx-msg", { hasText: words }).last();

  async function inGeneral(page: Page) {
    await open(page, "?one&guest&shell=phone");
    await settled(page);
    await room(page, "general").click();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    await noLongPress(page);
  }

  test("holding a message opens its actions while the finger is down; a tap or a scroll opens nothing", async ({ page }) => {
    await inGeneral(page);
    const words = message(page, "No plans, no agenda").locator(".nx-text");
    const sheet = page.getByRole("menu");
    const touch = await finger(page);
    await still(words);

    await touch.down(await middle(words));
    await expect(sheet).toBeVisible();
    await touch.up();
    await expect(sheet.locator(".k-menu-head")).toHaveText(/^Eli: No plans, no agenda/);
    await expect(sheet.locator("[data-kit='MenuItem']")).toHaveText(["Reply", "Copy text", "Pin", "Report to host…"]);
    // A tap on the dimmed page closes it.
    await page.locator(".k-menu-scrim").tap();
    await expect(sheet).toHaveCount(0);

    // A tap is a tap.
    await words.tap();
    await page.waitForTimeout(800);
    await expect(sheet).toHaveCount(0);

    // Down on the message and away up the screen, for longer than a hold.
    const at = await middle(words);
    await touch.down(at);
    for (let step = 1; step <= 6; step += 1) await touch.move({ x: at.x, y: at.y - step * 8 });
    await page.waitForTimeout(800);
    await touch.up();
    await expect(sheet).toHaveCount(0);
  });

  // As the finger lifts from a hold, Chromium sends a click where it was, as
  // an iPhone may, and by then the sheet has risen under it.
  test("the click a hold leaves behind chooses nothing from the sheet that rose under the finger", async ({ page }) => {
    await inGeneral(page);
    const sheet = page.getByRole("menu");
    const items = sheet.locator("[data-kit='MenuItem']");
    const touch = await finger(page);

    // The last message, low on the screen, where the sheet's actions rise.
    const last = message(page, "Putting it on now.").locator(".nx-text");
    await still(last);
    const at = await middle(last);
    await touch.down(at);
    await expect(sheet).toBeVisible();
    const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role='menuitem']")?.textContent ?? null, at);
    expect(under, "an action of the sheet's is under the finger").not.toBeNull();
    await touch.up();
    await page.waitForTimeout(300);
    await expect(sheet).toBeVisible();
    await expect(items).toHaveText(["Reply", "Copy text", "Pin", "Report to host…"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The next tap is a tap.
    await sheet.getByRole("menuitem", { name: "Reply" }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(screen(page)).toContainText("Replying to Eli");
  });

  test("holding a reaction pill lists who left it, and isn't holding its message", async ({ page }) => {
    await inGeneral(page);
    const row = message(page, "No plans, no agenda");
    await row.dispatchEvent("contextmenu");
    // Taken away by noLongPress: the sheet comes only from a finger now.
    await expect(page.getByRole("menu")).toHaveCount(0);
    const touch = await finger(page);
    await touch.down(await middle(row.locator(".nx-text")));
    await expect(page.getByRole("menu")).toBeVisible();
    await touch.up();
    await page.getByRole("menu").getByRole("group", { name: "React" }).getByRole("menuitem", { name: "❤️" }).tap();
    const pill = row.locator(".nx-react-pill:not(.nx-react-add)").first();
    await expect(pill.locator(".nx-react-count")).toHaveText("1");
    // The conversation moves up to make room for it.
    await still(pill);

    await touch.down(await middle(pill));
    await expect(page.getByRole("dialog", { name: "Everyone who reacted with ❤️" })).toBeVisible();
    await touch.up();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(pill).toHaveAttribute("aria-pressed", "true");
  });
});

// A row in the list opens with one tap (#704). On an iPhone a person's row and
// a group's took two: the first one's hover showed the row's buttons, and an
// iPhone takes a tap whose hover shows something to press as a hover only.
// No engine here has that rule, so `iPhoneTaps` (finger.ts) puts it in the
// page. A touch screen is a device with no hover, `(hover: none)`, in
// Chromium and WebKit alike; Chromium moves the hover for a tap, as an
// iPhone does, and Playwright's WebKit doesn't, so Chromium is the one that
// catches a row showing its buttons for a tap.
test.describe("one tap opens a row, on an iPhone's rule for taps (#704)", () => {
  test.use({ isMobile: true, hasTouch: true, userAgent: IPHONE });

  const rows = (page: Page, list: string) => page.getByRole("list", { name: list, exact: true });
  /** Every row's buttons, and whether any of them is showing. */
  const buttonsShowing = (page: Page) =>
    page.locator(".k-row-actions").evaluateAll((all) => all.filter((actions) => getComputedStyle(actions).display !== "none").length);

  test("one tap on a person's row or a group's opens it, and never shows the row's buttons", async ({ page }) => {
    await phone(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches), "a touch screen has no hover").toBe(true);
    await iPhoneTaps(page);

    await rows(page, "People here").getByRole("button", { name: /^Eli\b/ }).tap();
    await expect(screen(page)).toBeVisible();
    await expect(title(page)).toContainText("Eli");
    expect(await hoverOnly(page), "taps taken as a hover only").toEqual([]);
    await back(page).tap();
    await expect(list(page)).toBeVisible();
    expect(await buttonsShowing(page), "back on the list, the row's buttons").toBe(0);

    await rows(page, "Rooms").getByRole("button", { name: /^Eli and Sam/ }).tap();
    await expect(screen(page)).toBeVisible();
    await expect(title(page)).toContainText("Eli and Sam");
    expect(await hoverOnly(page), "taps taken as a hover only").toEqual([]);
    await back(page).tap();
    await expect(list(page)).toBeVisible();
    expect(await buttonsShowing(page), "back on the list, the row's buttons").toBe(0);

    // A room, which has no buttons, as before.
    await room(page, "general").tap();
    await expect(screen(page)).toBeVisible();
    expect(await hoverOnly(page)).toEqual([]);
  });

  test("one tap folds a server, whose ⋯ never shows for it", async ({ page }) => {
    await open(page, "?shell=phone");
    await settled(page);
    await iPhoneTaps(page);
    const server = page.locator(".nx-srv").first();
    const toggle = server.locator(".nx-srv-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await hoverOnly(page), "taps taken as a hover only").toEqual([]);
    // Its end, where the ⋯ is out of sight, folds it too: nothing there to press.
    const box = await toggle.boundingBox();
    if (!box) throw new Error("no header");
    await page.touchscreen.tap(box.x + box.width - 12, box.y + box.height / 2);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("one tap on a section's heading folds it, and one on a name or a link in a message does what it does", async ({ page }) => {
    await open(page, "?one&guest&shell=phone");
    await settled(page);
    await iPhoneTaps(page);
    const people = page.getByRole("button", { name: /^People\b/ });
    await people.tap();
    await expect(people).toHaveAttribute("aria-expanded", "false");
    await people.tap();
    await expect(people).toHaveAttribute("aria-expanded", "true");

    await room(page, "general").tap();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    const name = page.locator(".nx-msg-person").first();
    await name.tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await hoverOnly(page), "taps taken as a hover only").toEqual([]);
  });

  // The away picker's × (#708) is always in sight, so one tap takes a message
  // out, and each is a thumb's size, as are the messages beside them.
  test("one tap on an away message's × takes it out, and each is a thumb's size (#708)", async ({ page }) => {
    await phone(page);
    await iPhoneTaps(page);
    await page.getByRole("region", { name: "You" }).getByRole("button", { name: "Away" }).tap();
    const editor = page.getByRole("dialog", { name: "Away message" });
    const bank = editor.getByRole("list", { name: "Your away messages" });
    await expect(bank.getByRole("listitem")).toHaveCount(6);
    // Laid out, as a finger finds them: the picker grows a touch as it opens.
    const sizes = await bank.getByRole("button").evaluateAll((buttons) => buttons.flatMap((button) => (button instanceof HTMLElement ? [{ width: button.offsetWidth, height: button.offsetHeight }] : [])));
    expect(sizes).toHaveLength(12);
    for (const size of sizes) {
      expect(size.height).toBeGreaterThanOrEqual(44);
      expect(size.width).toBeGreaterThanOrEqual(44);
    }
    expect(await sticksOut(page)).toEqual([]);

    await editor.getByRole("button", { name: "Forget “asleep 💤”" }).tap();
    await expect(bank.getByRole("listitem")).toHaveCount(5);
    await expect(bank).not.toContainText("asleep");
    expect(await hoverOnly(page), "taps taken as a hover only").toEqual([]);
  });
});

// Held with a finger, a person's row or a group's raises what its buttons do,
// from the bottom, as a held message does (#686, #704). Chromium only, where a
// test can hold a finger down (finger.ts); the long-press is taken away, as an
// iPhone sends none.
test.describe("a row held with a finger raises its actions from the bottom (#704)", () => {
  test.use({ isMobile: true, hasTouch: true, userAgent: IPHONE });
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test hold a finger down");

  const sheet = (page: Page) => page.getByRole("menu");
  const items = (page: Page) => sheet(page).locator("[data-kit='MenuItem']");
  const person = (page: Page, list: string, who: string) =>
    page.getByRole("list", { name: list, exact: true }).getByRole("button", { name: new RegExp(`^${who},`) });
  const knocks = async (page: Page) => (await did(page)).filter((line) => line.endsWith("/knock"));

  async function onTheList(page: Page) {
    await phone(page);
    await noLongPress(page);
  }

  test("a person's: their card and Knock under their name; a tap opens them instead, and the sheet's choices are taps", async ({ page }) => {
    await onTheList(page);
    const touch = await finger(page);
    const eli = person(page, "People here", "Eli");
    await still(eli);

    await touch.down(await middle(eli));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await expect(sheet(page)).toHaveAccessibleName("Actions for Eli");
    await expect(sheet(page).locator(".k-menu-head")).toHaveText(/^Eli/);
    await expect(items(page)).toHaveText(["Eli's card", "Knock on Eli's door"]);
    // Nothing chosen, nothing opened, by the hold.
    await expect(screen(page)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await sticksOut(page), "the sheet").toEqual([]);

    // Its card, beside the row.
    await sheet(page).getByRole("menuitem", { name: "Eli's card" }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Eli" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Knock, from the sheet: knocked once, and the row shakes.
    await touch.down(await middle(eli));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await sheet(page).getByRole("menuitem", { name: "Knock on Eli's door" }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => knocks(page)).toHaveLength(1);
    await expect(page.locator(".k-row[data-knocked='yes']")).toHaveCount(1);

    // A tap on the dimmed page closes it, and opens nothing under it: the
    // list's rows are everywhere there.
    await touch.down(await middle(eli));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await page.locator(".k-menu-scrim").tap({ position: { x: 200, y: 300 } });
    await expect(sheet(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(screen(page)).toHaveCount(0);

    // A tap is the person, with no sheet.
    await eli.tap();
    await expect(screen(page)).toBeVisible();
    await page.waitForTimeout(800);
    await expect(sheet(page)).toHaveCount(0);
  });

  test("offline, Knock is greyed out and says why, and choosing it knocks nothing", async ({ page }) => {
    await onTheList(page);
    await page.getByRole("button", { name: /^Offline\b/ }).tap();
    const gone = page.getByRole("list", { name: "Offline", exact: true }).getByRole("button").first();
    await still(gone);
    const who = (await gone.getAttribute("aria-label"))?.split(",")[0] ?? "";
    const touch = await finger(page);
    await touch.down(await middle(gone));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    const knock = sheet(page).getByRole("menuitem", { name: `Can't knock while ${who} is offline.` });
    await expect(knock).toHaveAttribute("aria-disabled", "true");
    // Greyed out, it isn't enabled as far as a test goes; pressed all the same.
    await knock.tap({ force: true });
    await page.waitForTimeout(300);
    expect(await knocks(page)).toEqual([]);
    await expect(sheet(page)).toBeVisible();
  });

  test.describe("low on the screen, where the sheet rises under the finger", () => {
    // Short enough that Sam, the last row, scrolled to the list's end, is
    // where the sheet's actions rise.
    test.use({ viewport: { width: 411, height: 700 } });

    test("the click a hold leaves behind chooses nothing from the sheet, and the next tap does", async ({ page }) => {
      await onTheList(page);
      const sam = person(page, "Away", "Sam");
      await sam.evaluate((row) => row.scrollIntoView({ block: "end" }));
      await still(sam);
      const at = await middle(sam);
      const touch = await finger(page);
      await touch.down(at);
      await expect(sheet(page)).toBeVisible();
      const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role='menuitem']")?.textContent ?? null, at);
      expect(under, "an action of the sheet's is under the finger").not.toBeNull();
      await touch.up();
      await page.waitForTimeout(300);
      await expect(sheet(page)).toBeVisible();
      await expect(items(page)).toHaveText(["Sam's card", "Knock on Sam's door"]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await knocks(page)).toEqual([]);
      await expect(screen(page)).toHaveCount(0);

      await sheet(page).getByRole("menuitem", { name: "Knock on Sam's door" }).tap();
      await expect.poll(() => knocks(page)).toHaveLength(1);
    });
  });

  test("a group's: Leave under its name, then its question; Stay changes nothing, Leave leaves", async ({ page }) => {
    await onTheList(page);
    const group = page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^Eli and Sam/ });
    await still(group);
    const touch = await finger(page);
    await touch.down(await middle(group));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await page.waitForTimeout(300);
    await expect(sheet(page)).toHaveAccessibleName("Actions for Eli and Sam");
    await expect(sheet(page).locator(".k-menu-head")).toHaveText("Eli and Sam");
    await expect(items(page)).toHaveText(["Leave this group…"]);
    await expect(screen(page)).toHaveCount(0);
    expect(await sticksOut(page), "the sheet").toEqual([]);

    await sheet(page).getByRole("menuitem", { name: "Leave this group…" }).tap();
    const ask = page.getByRole("dialog", { name: "Leave Eli and Sam" });
    await expect(ask).toContainText("Nobody can add you back");
    expect(await sticksOut(page), "the question").toEqual([]);
    await ask.getByRole("button", { name: "Stay" }).tap();
    await expect(ask).toHaveCount(0);
    await expect(group).toBeVisible();

    await touch.down(await middle(group));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await sheet(page).getByRole("menuitem", { name: "Leave this group…" }).tap();
    await ask.getByRole("button", { name: "Leave", exact: true }).tap();
    await expect(group).toHaveCount(0);
    expect((await did(page)).filter((line) => line.startsWith("leave "))).toEqual(["leave d-eli-sam"]);

    // A room has nothing to raise.
    const general = room(page, "general");
    await touch.down(await middle(general));
    await page.waitForTimeout(800);
    await touch.up();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("a server's header: Quiet and the order under its name, and a tap still folds it", async ({ page }) => {
    await open(page, "?shell=phone");
    await settled(page);
    await noLongPress(page);
    const toggle = page.locator(".nx-srv").first().locator(".nx-srv-toggle");
    const name = (await page.locator(".nx-srv").first().getAttribute("aria-label")) ?? "";
    await still(toggle);
    const touch = await finger(page);
    await touch.down(await middle(toggle));
    await expect(sheet(page)).toBeVisible();
    await touch.up();
    await page.waitForTimeout(300);
    await expect(sheet(page).locator(".k-menu-head")).toHaveText(name);
    await expect(items(page)).toHaveText(["Quiet", "Move down"]);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await sticksOut(page), "the sheet").toEqual([]);
    await sheet(page).getByRole("menuitemcheckbox", { name: "Quiet" }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator(".nx-srv").first()).toHaveAttribute("data-quiet", "yes");
  });
});

// An iPhone has no Back of its own, so the page goes back with a finger
// swiped in from the left edge, as an iPhone's apps do (#697). Chromium is the
// only engine a test can move a finger in (finger.ts), so these are its, with
// the iPhone's web view named by its user agent.
test.describe("on an iPhone, a swipe in from the left edge goes back (#697)", () => {
  test.use({ isMobile: true, hasTouch: true, userAgent: IPHONE });
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test put a finger down and move it");

  const side = (page: Page) => page.locator(".nx-side");
  /**
   * Which screen a person sees at (x, y): the first under it, through
   * anything see-through on top, or "covered" when something without one
   * paints over it.
   */
  const shown = (page: Page, x: number, y: number) =>
    page.evaluate(
      ({ x, y }) => {
        for (const element of document.elementsFromPoint(x, y)) {
          const screen = element.closest("[data-screen]");
          if (screen) return screen.getAttribute("data-screen");
          const paint = getComputedStyle(element).backgroundColor;
          if (paint !== "transparent" && paint !== "rgba(0, 0, 0, 0)") return "covered";
        }
        return null;
      },
      { x, y },
    );

  async function inGeneral(page: Page, query = "") {
    await open(page, `?one${query}&shell=phone`);
    await settled(page);
    await room(page, "general").click();
    await expect(page.getByRole("log")).toContainText("Putting it on now.");
    await still(page.getByRole("log"));
  }

  test("past a third of the way, the room goes back to the list, following the finger with the list under it", async ({ page }) => {
    await inGeneral(page);
    // Android's Back isn't listened for: the swipe is the iPhone's only way.
    expect(await page.evaluate(() => window.core?.back())).toBe(false);

    const touch = await drag(page, { x: 4, y: 500 }, { x: 204, y: 500 }, false);
    await expect.poll(() => over(side(page))).toBeCloseTo(200, 0);
    // The list is under it, there to see where the room has moved off.
    expect(await shown(page, 100, 500)).toBe("list");
    expect(await shown(page, 300, 500)).toBe("chat");
    await touch.up();
    await expect(screen(page)).toHaveCount(0);
    await expect(list(page)).toBeVisible();
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
  });

  test("let go short of a third, the room slides back into place and stays", async ({ page }) => {
    await inGeneral(page);
    const touch = await drag(page, { x: 4, y: 500 }, { x: 84, y: 500 }, false);
    await expect.poll(() => over(side(page))).toBeCloseTo(80, 0);
    await touch.up();
    await expect.poll(() => over(side(page))).toBe(0);
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    await expect(screen(page)).toBeVisible();
    await expect(list(page)).toBeHidden();
  });

  test("a finger starting away from the edge moves nothing and goes nowhere", async ({ page }) => {
    await inGeneral(page);
    const touch = await drag(page, { x: 60, y: 500 }, { x: 330, y: 500 }, false);
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    expect(await over(side(page))).toBe(0);
    await touch.up();
    await page.waitForTimeout(400);
    await expect(screen(page)).toBeVisible();
    await expect(list(page)).toBeHidden();
  });

  test("a finger from the edge going up or down scrolls the conversation, and goes nowhere", async ({ page }) => {
    await inGeneral(page, "&many=200");
    const log = page.getByRole("log");
    const top = () => log.evaluate((element) => element.scrollTop);
    const before = await top();
    await drag(page, { x: 6, y: 300 }, { x: 10, y: 700 });
    await expect.poll(top).toBeLessThan(before - 200);
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    await expect(screen(page)).toBeVisible();
    await expect(list(page)).toBeHidden();
  });

  test("a message held at the edge opens its actions, and moving on after doesn't go back", async ({ page }) => {
    await inGeneral(page, "&guest");
    await noLongPress(page);
    const words = page.locator(".nx-msg", { hasText: "No plans, no agenda" }).last().locator(".nx-text");
    const box = await words.boundingBox();
    if (!box) throw new Error("the message isn't on the screen");
    const at = { x: 6, y: box.y + box.height / 2 };
    const touch = await finger(page);
    await touch.down(at);
    await expect(page.getByRole("menu")).toBeVisible();
    for (let step = 1; step <= 20; step += 1) {
      await touch.move({ x: at.x + step * 10, y: at.y });
      await page.waitForTimeout(16);
    }
    await touch.up();
    await page.waitForTimeout(400);
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(screen(page)).toBeVisible();
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
  });

  test("screens over screens go back one at a time: a search hit to Search, then Search to the list", async ({ page }) => {
    await phone(page);
    await list(page).getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("moon");
    await page.locator(".nx-hit-main").first().click();
    await expect(title(page)).toContainText("general");
    await still(page.getByRole("log"));

    await drag(page, { x: 4, y: 500 }, { x: 204, y: 500 });
    await expect(title(page)).toHaveText("Search");
    await expect.poll(() => over(side(page))).toBe(0);
    await drag(page, { x: 4, y: 500 }, { x: 204, y: 500 });
    await expect(list(page)).toBeVisible();
    await expect(screen(page)).toHaveCount(0);
  });

  test("Settings goes back the same way: a section to the sections, the sections to the list under them", async ({ page }) => {
    await phone(page);
    await list(page).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator(".nx-phone-over [data-screen='settings']");
    const sections = settings.getByRole("navigation", { name: "Settings" });
    await sections.getByText("Appearance").click();
    await expect(settings.locator(".nx-set-title")).toHaveText("Appearance");

    await drag(page, { x: 4, y: 500 }, { x: 204, y: 500 });
    await expect(sections).toBeVisible();
    await expect.poll(() => over(settings)).toBe(0);

    const touch = await drag(page, { x: 4, y: 500 }, { x: 204, y: 500 }, false);
    await expect.poll(() => over(settings)).toBeCloseTo(200, 0);
    expect(await shown(page, 100, 500)).toBe("list");
    await touch.up();
    await expect(page.locator(".nx-phone-over")).toHaveCount(0);
    await expect(list(page)).toBeVisible();
  });
});

// Android's own Back is the button and the swipe in from the edge both, and
// reaches the page as Back (useBackButton.ts). A swipe of the page's own as
// well would go back twice.
test.describe("on Android, the swipe in from the edge is Android's Back (#697)", () => {
  test.use({ isMobile: true, hasTouch: true, userAgent: ANDROID });
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test put a finger down and move it");

  test("the page adds no swipe of its own, so Back goes back one screen", async ({ page }) => {
    await phone(page);
    await list(page).getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("moon");
    await page.locator(".nx-hit-main").first().click();
    await expect(title(page)).toContainText("general");

    const touch = await drag(page, { x: 4, y: 500 }, { x: 304, y: 500 }, false);
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    await touch.up();
    await page.waitForTimeout(400);
    await expect(title(page)).toContainText("general");

    // Android's Back, as its shell hands it over: one screen, to Search.
    expect(await page.evaluate(() => window.core?.back())).toBe(true);
    await expect(title(page)).toHaveText("Search");
  });
});

test("a group is left from its screen's ⋯, the menu and the question rising from the bottom, and the list comes back without it (#565)", async ({ page }) => {
  await phone(page);
  const group = page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^Eli and Sam/ });
  await group.click();
  await expect(screen(page)).toBeVisible();
  await title(page).getByRole("button", { name: "More for Eli and Sam" }).click();
  const sheet = page.getByRole("menu");
  await expect(sheet.locator(".k-menu-head")).toHaveText("Eli and Sam");
  expect(await sticksOut(page), "the menu").toEqual([]);
  await sheet.getByRole("menuitem", { name: "Leave this group…" }).click();

  const ask = page.getByRole("dialog", { name: "Leave Eli and Sam" });
  await expect(ask).toContainText("Nobody can add you back");
  expect(await sticksOut(page), "the question").toEqual([]);
  await ask.getByRole("button", { name: "Leave", exact: true }).click();

  await expect(list(page)).toBeVisible();
  await expect(screen(page)).toHaveCount(0);
  await expect(group).toHaveCount(0);
  expect((await did(page)).filter((line) => line.startsWith("leave "))).toEqual(["leave d-eli-sam"]);
});

// Voice rooms on the phone (#429): voice runs in the page there
// (lib/pageVoice.ts; next-phone-voice-room.spec.ts proves the call itself).
// Here, what the screens show. The fixture's microphone is a quiet tone made
// in the page, and no server offers a connection, so a join is the screens'
// alone.

/** In voice in #general, from its own voice line. */
async function inVoice(page: Page) {
  await phone(page);
  await room(page, "general").click();
  await page.getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("group", { name: "Your voice" }).first()).toBeVisible();
}

/** The height of each control in a group, by name. */
async function heights(page: Page, group: string): Promise<number[]> {
  return page
    .getByRole("group", { name: group })
    .first()
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
}

test("voice: Mute, Deafen and Leave are a thumb's size, in the room and on the list", async ({ page }) => {
  await open(page, "?micquiet&one&shell=phone");
  await settled(page);
  await room(page, "general").click();
  await page.getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Join" }).click();
  const here = await heights(page, "Your voice");
  expect(here).toHaveLength(3);
  for (const height of here) expect(height).toBeGreaterThanOrEqual(44);
  expect(await sticksOut(page)).toEqual([]);

  await back(page).click();
  const bar = page.getByRole("region", { name: "In voice in #general" });
  await expect(bar).toBeVisible();
  for (const height of await bar.getByRole("group", { name: "Your voice" }).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))) {
    expect(height).toBeGreaterThanOrEqual(44);
  }
  expect(await sticksOut(page)).toEqual([]);
});

test("voice: every other screen says where your voice is, with your controls, and goes back there", async ({ page }) => {
  await inVoice(page);
  await back(page).click();

  // Another room: your voice in its line's place, never "Talk here instead".
  await room(page, "weekend-plans").click();
  const line = screen(page).getByRole("group", { name: "Your voice call" });
  await expect(line).toContainText("In voice in #general");
  await expect(screen(page).getByRole("button", { name: "Talk here instead" })).toHaveCount(0);
  for (const height of await heights(page, "Your voice")) expect(height).toBeGreaterThanOrEqual(44);
  expect(await sticksOut(page)).toEqual([]);

  // Mute from here mutes the call: the room is told, and every line says so.
  await line.getByRole("button", { name: "Mute" }).click();
  await expect(line.getByRole("button", { name: "Muted" })).toBeVisible();
  await expect.poll(async () => (await did(page)).some((entry) => entry.includes('"op":"voice.join"') && entry.includes('"muted":true'))).toBe(true);

  // Its words go back to the room you're in voice in, over this one.
  await line.getByRole("button", { name: /In voice in #general/ }).click();
  await expect(title(page)).toContainText("general");
  await expect(screen(page).getByRole("group", { name: "Your voice call" })).toHaveCount(0);
  await expect(screen(page).getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Muted" })).toBeVisible();
  await back(page).click();
  await expect(title(page)).toContainText("weekend-plans");

  // Search too, under its title.
  await back(page).click();
  await page.getByRole("button", { name: "Search" }).click();
  await expect(screen(page).getByRole("group", { name: "Your voice call" })).toContainText("In voice in #general");
  expect(await sticksOut(page)).toEqual([]);

  // Leave from here: the line goes, and the list's bar with it.
  await screen(page).getByRole("group", { name: "Your voice call" }).getByRole("button", { name: "Leave voice" }).click();
  await expect(screen(page).getByRole("group", { name: "Your voice call" })).toHaveCount(0);
  await expect.poll(async () => (await did(page)).some((entry) => entry.includes('"op":"voice.leave"'))).toBe(true);
});

test("voice: nobody plays louder than as sent on a phone, and it says this phone", async ({ page }) => {
  await inVoice(page);
  await back(page).click();
  await page.getByRole("region", { name: "In voice in #general" }).getByRole("button", { name: /Eli/ }).click();
  const slider = page.getByRole("slider", { name: "How loud Eli is for you" });
  await expect(slider).toHaveAttribute("max", "1");
  await expect(page.getByText("Only for you, on this phone.")).toBeVisible();
});

test("voice: the call bar shows while in voice, follows mute, and its buttons work (#429)", async ({ page }) => {
  await inVoice(page);
  const bars = async () => (await did(page)).filter((line) => line.startsWith("phone_call_bar:"));
  await expect.poll(async () => (await bars()).at(-1)).toBe('phone_call_bar:{"bar":{"where":"#general","muted":false,"deafened":false}}');

  // Mute pressed on the bar, outside the app: the room is told, the bar redrawn.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("linger:callbar", { detail: "mute" })));
  await expect.poll(async () => (await bars()).at(-1)).toBe('phone_call_bar:{"bar":{"where":"#general","muted":true,"deafened":false}}');
  await expect(page.getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Muted" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("linger:callbar", { detail: "unmute" })));
  await expect.poll(async () => (await bars()).at(-1)).toBe('phone_call_bar:{"bar":{"where":"#general","muted":false,"deafened":false}}');

  // Leave on the bar: out of voice, and the bar goes.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("linger:callbar", { detail: "leave" })));
  await expect.poll(async () => (await bars()).at(-1)).toBe('phone_call_bar:{"bar":null}');
  await expect(page.getByRole("group", { name: "Voice in this conversation" }).getByRole("button", { name: "Join" })).toBeVisible();
});

// A shared file (#703). On an iPhone, Download handed to Safari opened a blank
// tab that seemed to do nothing, and the address shown after couldn't be
// selected with a finger. Now the iPhone's shell fetches the file and its
// share sheet offers it (src-tauri/src/phone_save.rs): the card asks the
// shell, never the browser, and the address has a Copy beside it. Android's
// Chrome saves a download, so there it still goes to the browser.
test.describe("a shared file (#703)", () => {
  /** Where the fixture's server serves the PDF Sam shares (`?file`), and Media's tile of it. */
  const ADDRESS = "https://good-company.example/media/river-loop-trail-map.pdf";
  const card = (page: Page) => page.locator(".nx-att-card", { hasText: "river-loop-trail-map.pdf" });
  const opened = async (page: Page) => (await did(page)).filter((line) => line.startsWith("open "));
  const saves = async (page: Page) => (await did(page)).filter((line) => line.startsWith("phone_save "));

  /** A clipboard that writes down what it's given, and refuses while `window.refuse` is set. */
  function fakeClipboard() {
    const copied: string[] = [];
    Object.assign(window, { copied, refuse: false });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if ((window as unknown as { refuse: boolean }).refuse) throw new Error("refused");
          copied.push(text);
        },
      },
    });
  }
  const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);

  /** #general on the phone, with Sam's PDF in it. */
  async function fileIn(page: Page, query = "") {
    await page.addInitScript(fakeClipboard);
    await open(page, `?one&shell=phone&file${query}`);
    await settled(page);
    await room(page, "general").click();
    await expect(card(page)).toBeVisible();
  }

  test.describe("on an iPhone", () => {
    test.use({ userAgent: IPHONE });

    test("Download asks the app for the file, is busy until the share sheet shows, then adds nothing", async ({ page }) => {
      await fileIn(page, "&savehold");
      const download = card(page).getByRole("button", { name: "Download" });
      await download.click();
      await expect(download).toHaveAttribute("aria-busy", "true");
      expect(await saves(page)).toEqual([`phone_save ${ADDRESS} river-loop-trail-map.pdf`]);
      await page.evaluate(() => window.core?.saved());
      await expect(download).not.toHaveAttribute("aria-busy", "true");
      // The share sheet is the answer: no note about a browser, and no address.
      await expect(card(page).getByRole("status")).toHaveCount(0);
      await expect(card(page).getByRole("textbox")).toHaveCount(0);
      expect(await opened(page)).toEqual([]);
    });

    test("a file the app couldn't get says so, offers another go, and the address to copy", async ({ page }) => {
      await fileIn(page, "&savefail");
      await card(page).getByRole("button", { name: "Download" }).click();
      await expect(card(page).getByRole("alert")).toHaveText("Couldn't get the file. Try again, or copy its address.");
      await expect(card(page).getByRole("textbox", { name: "Address of river-loop-trail-map.pdf" })).toHaveValue(ADDRESS);
      await card(page).getByRole("button", { name: "Copy" }).click();
      await expect(card(page).getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await copied(page)).toEqual([ADDRESS]);
      const again = card(page).getByRole("button", { name: "Try again" });
      await again.click();
      await expect.poll(() => saves(page)).toHaveLength(2);
      await expect(card(page).getByRole("alert")).toBeVisible();
      expect(await opened(page)).toEqual([]);
    });

    test("Media's download asks the app too, and says it's getting it meanwhile", async ({ page }) => {
      await open(page, "?one&shell=phone&savehold");
      await settled(page);
      await list(page).getByRole("button", { name: "Media", exact: true }).click();
      const tile = page.locator(".nx-tile", { hasText: "river-loop-trail-map.pdf" });
      await tile.getByRole("button", { name: "Download river-loop-trail-map.pdf" }).click();
      await expect(tile.getByRole("button", { name: "Getting river-loop-trail-map.pdf…" })).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator(".nx-media-line")).toHaveText("Getting river-loop-trail-map.pdf…");
      expect(await saves(page)).toEqual([`phone_save ${ADDRESS} river-loop-trail-map.pdf`]);
      await page.evaluate(() => window.core?.saved());
      await expect(tile.getByRole("button", { name: "Download river-loop-trail-map.pdf" })).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator(".nx-media-line")).not.toHaveText(/Getting/);
      expect(await opened(page)).toEqual([]);
    });
  });

  test.describe("on Android", () => {
    test.use({ userAgent: ANDROID });

    test("Download goes to the browser, which saves it, and the address can be copied", async ({ page }) => {
      await fileIn(page);
      await card(page).getByRole("button", { name: "Download" }).click();
      await expect(card(page).getByRole("status")).toHaveText("Your browser has it: look in its downloads. If nothing opened, copy this address into it.");
      expect(await opened(page)).toEqual([`open ${ADDRESS}`]);
      expect(await saves(page)).toEqual([]);
      await card(page).getByRole("button", { name: "Copy" }).click();
      await expect(card(page).getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await copied(page)).toEqual([ADDRESS]);
    });
  });
});
