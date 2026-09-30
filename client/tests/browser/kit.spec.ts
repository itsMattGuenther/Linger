/**
 * The kit's rules, measured in a real browser on the gallery
 * (`tests/fixtures/kit.html`). Geometry, not pixel snapshots: snapshots differ
 * between machines and fonts, while "every control is 24, 32 or 40 tall" is
 * true or false everywhere. Each test names the old bug class it forbids.
 *
 * docs/design/system.md lists every rule and the test that enforces it.
 */
import { expect, type Page, test } from "@playwright/test";

const ALLOWED_CONTROL_HEIGHTS = [24, 32, 40];
const HALF_PIXEL = 0.5;

async function openGallery(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/kit.html");
  await expect(page.locator("[data-section]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test.beforeEach(async ({ page }) => {
  await openGallery(page);
});

test("every control is 24, 32 or 40px tall (#88, #146: mis-sized buttons)", async ({ page }) => {
  const controls = await page.$$eval("[data-kit-control]", (els) =>
    els
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          what: `${el.getAttribute("data-kit") ?? el.className} "${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}"`,
          height: rect.height,
          visible: rect.width > 0 && rect.height > 0,
        };
      })
      .filter((c) => c.visible),
  );
  expect(controls.length).toBeGreaterThan(60);
  const wrong = controls.filter((c) => !ALLOWED_CONTROL_HEIGHTS.some((h) => Math.abs(c.height - h) < 0.01));
  expect(wrong.map((c) => `${c.what}: ${c.height}px`)).toEqual([]);
});

test("icons and markers sit exactly in the middle of their boxes (#144, #164, #172: off-center)", async ({ page }) => {
  const off = await page.evaluate((tolerance) => {
    const problems: string[] = [];
    const center = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const check = (outer: Element, inner: Element | null, what: string, axes: "xy" | "y") => {
      if (!inner) return;
      const a = center(outer);
      const b = center(inner);
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if ((axes === "xy" && dx > tolerance) || dy > tolerance) problems.push(`${what}: off by ${dx.toFixed(2)}, ${dy.toFixed(2)}`);
    };
    for (const button of document.querySelectorAll('[data-kit="IconButton"]')) {
      check(button, button.querySelector('[data-kit="Icon"]'), `IconButton "${button.getAttribute("aria-label")}"`, "xy");
    }
    for (const button of document.querySelectorAll('[data-kit="Button"]')) {
      check(button, button.querySelector('[data-kit="Icon"]'), `Button "${button.textContent?.trim()}" icon`, "y");
    }
    for (const slot of document.querySelectorAll('[data-kit="MarkerSlot"]')) {
      const inner = slot.firstElementChild;
      if (inner && !inner.closest('[data-kit="GroupMarker"]')?.isSameNode(inner)) check(slot, inner, "marker in its slot", "xy");
      if (inner?.matches('[data-kit="GroupMarker"]')) check(slot, inner, "group in its slot", "xy");
    }
    return problems;
  }, HALF_PIXEL);
  expect(off).toEqual([]);
});

// Idle was the here dot, a little dimmed, and easy to miss beside it (#259).
test("idle and away are their mark at half strength, and offline is a hollow dot, in their color at both sizes (#301)", async ({ page }) => {
  for (const size of ["md", "sm"]) {
    const marks = await page.evaluate((size) => {
      const find = (state: string) => document.querySelector(`[role="img"][aria-label="Eli (${size}), ${state}"]`);
      const read = (node: Element | null) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          background: style.backgroundColor,
          opacity: style.opacity,
          ring: style.boxShadow,
          glyph: node.querySelector("svg") !== null,
          width: box.width,
          height: box.height,
        };
      };
      const tokens = getComputedStyle(document.documentElement);
      return {
        here: read(find("here")),
        idle: read(find("idle")),
        away: read(find("away")),
        offline: read(find("offline")),
        ring: tokens.getPropertyValue(size === "sm" ? "--marker-ring-sm" : "--marker-ring").trim(),
      };
    }, size);
    const { here, idle, away, offline } = marks;
    // Idle is the dot itself, their color, at half strength: no 💤.
    expect(idle, size).toMatchObject({ background: here?.background, opacity: "0.5", glyph: false, width: here?.width, height: here?.height });
    // Away is the moon at half strength.
    expect(away, size).toMatchObject({ opacity: "0.5", glyph: true });
    // Offline is the dot's outline in their color, the dot's own size.
    expect(offline, size).toMatchObject({ background: "rgba(0, 0, 0, 0)", glyph: false, width: here?.width, height: here?.height });
    expect(offline?.ring, size).toBe(`${here?.background} 0px 0px 0px ${marks.ring} inset`);
  }
});

// A ring was kept out of the kit because one can stop reading as a ring at a
// small size (#301). Painted, the offline dot has its color at the edge and
// the page's own background in the middle, at 6px and 8px, at 100% and 200%.
for (const scale of [1, 2]) {
  test.describe(`at ${scale * 100}%`, () => {
    test.use({ deviceScaleFactor: scale });
    test("an offline dot is painted hollow at both sizes (#301)", async ({ page }) => {
      await openGallery(page);
      for (const size of ["md", "sm"]) {
        const mark = page.getByRole("img", { name: `Eli (${size}), offline` });
        const png = await mark.screenshot({ animations: "disabled" });
        const painted = await page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          if (!context) return null;
          context.drawImage(image, 0, 0);
          const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
          const w = image.width;
          const h = image.height;
          const middle = at(Math.floor(w / 2), Math.floor(h / 2));
          // The brightest pixel along the middle row: the ring's color.
          let edge = middle;
          for (let x = 0; x < w; x += 1) {
            const pixel = at(x, Math.floor(h / 2));
            if (pixel.reduce((a, b) => a + b, 0) > edge.reduce((a, b) => a + b, 0)) edge = pixel;
          }
          return { middle, edge };
        }, png.toString("base64"));
        expect(painted, size).not.toBeNull();
        const lift = (pixel: number[]) => pixel.reduce((a, b) => a + b, 0);
        // The ring is clearly brighter than its own middle: it reads hollow.
        expect(lift(painted?.edge ?? []) - lift(painted?.middle ?? []), `${size} ring over its middle`).toBeGreaterThan(40);
      }
    });
  });
}

test("a person with no status line has their name level with their marker, not above an empty line", async ({ page }) => {
  const off = await page.evaluate((tolerance) => {
    const problems: string[] = [];
    for (const row of document.querySelectorAll('[data-kit="Row"][data-row-kind="two"]')) {
      if (row.querySelector(".k-row-detail")) continue;
      const slot = row.querySelector('[data-kit="MarkerSlot"]')?.getBoundingClientRect();
      const top = row.querySelector(".k-row-top")?.getBoundingClientRect();
      if (!slot || !top) continue;
      const dy = Math.abs(slot.top + slot.height / 2 - (top.top + top.height / 2));
      if (dy > tolerance) problems.push(`${row.textContent?.trim().slice(0, 20)}: off by ${dy.toFixed(2)}`);
    }
    return problems;
  }, HALF_PIXEL);
  expect(off).toEqual([]);
  // The gallery has such a row, or this proves nothing.
  expect(await page.locator('[data-kit="Row"][data-row-kind="two"]:not(:has(.k-row-detail))').count()).toBeGreaterThan(0);
});

test("rows of a kind are one height, in every name face (uneven rows)", async ({ page }) => {
  const rows = await page.$$eval('[data-kit="Row"]', (els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-row-kind"),
      height: el.querySelector(".k-row-main")?.getBoundingClientRect().height ?? -1,
      text: el.textContent?.trim().slice(0, 30),
    })),
  );
  const one = rows.filter((r) => r.kind === "one");
  const two = rows.filter((r) => r.kind === "two");
  expect(one.length).toBeGreaterThan(12);
  expect(two.length).toBeGreaterThan(12);
  expect(one.filter((r) => r.height !== 32).map((r) => `${r.text}: ${r.height}`)).toEqual([]);
  expect(two.filter((r) => r.height !== 48).map((r) => `${r.text}: ${r.height}`)).toEqual([]);

  const nameLines = await page.$$eval('[data-kit="Row"] [data-kit="Name"]', (els) =>
    els.map((el) => el.getBoundingClientRect().height),
  );
  expect(new Set(nameLines)).toEqual(new Set([20]));
});

test("names in a list start at one x, whatever the marker (#181, names that don't line up)", async ({ page }) => {
  const columns = await page.$$eval("[data-kit-column], [data-kit-list]", (els) =>
    els.map((column) => {
      const starts = [...column.querySelectorAll("[data-kit-row-text], .k-section-text")].map((el) => ({
        x: el.getBoundingClientRect().left,
        text: el.textContent?.trim().slice(0, 24),
      }));
      return { column: column.getAttribute("aria-label") ?? column.querySelector(".k-section-text")?.textContent ?? "column", starts };
    }),
  );
  expect(columns.length).toBeGreaterThan(3);
  const problems: string[] = [];
  for (const { column, starts } of columns) {
    const first = starts[0];
    if (!first) continue;
    for (const start of starts) {
      if (Math.abs(start.x - first.x) > HALF_PIXEL) problems.push(`${column}: "${start.text}" starts at ${start.x}, "${first.text}" at ${first.x}`);
    }
  }
  expect(problems).toEqual([]);
});

test("text that does not fit ends in an ellipsis, never a hard clip", async ({ page }) => {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const clipping = (value: string) => value === "hidden" || value === "clip";
    const scrolling = (value: string) => value === "auto" || value === "scroll";
    const all = document.querySelectorAll("main *");
    let overflowing = 0;
    for (const el of all) {
      if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (!ownText) continue;
      // Screen-reader-only text is squeezed into a 1px box on purpose.
      const box = el.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1) continue;
      // An ellipsis is only ever drawn by a block-level text box. On a flex or
      // grid container the property is set but nothing is drawn: the text is
      // simply cut, which is the bug this test exists for.
      const drawsEllipsis = !/flex|grid/.test(style.display);
      const ellipsizes =
        drawsEllipsis && style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap" && clipping(style.overflowX);
      if (el.scrollWidth > el.clientWidth + 1 && style.display !== "inline") {
        overflowing += 1;
        if (!ellipsizes) out.push(`"${el.textContent?.trim().slice(0, 40)}" overflows its own box without an ellipsis`);
        continue;
      }
      // Clipped by an ancestor: text running under an edge it cannot see past.
      let parent = el.parentElement;
      while (parent && parent.tagName !== "MAIN") {
        const ps = getComputedStyle(parent);
        if (scrolling(ps.overflowX)) break;
        if (clipping(ps.overflowX)) {
          const inner = el.getBoundingClientRect();
          const outer = parent.getBoundingClientRect();
          if (inner.right > outer.right + 1 && !ellipsizes) {
            out.push(`"${el.textContent?.trim().slice(0, 40)}" runs past the edge of its container`);
          }
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (overflowing < 8) out.push(`only ${overflowing} overflowing texts found; the gallery must keep its long-text cases`);
    return out;
  });
  expect(problems).toEqual([]);
});

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';

test("every hit target is at least 24px", async ({ page }) => {
  const small = await page.$$eval(INTERACTIVE, (els) =>
    els.flatMap((el) => {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return [];
      // A splitter is the one exception (docs/design/system.md, "Splitter"):
      // its target is its whole length, 8px across, so it never covers the
      // scrollbar or the controls beside it. Its own test measures that.
      if (el.getAttribute("role") === "separator") return [];
      // An input's target is its box or its label, not the bare element.
      const target = el.closest("label") ?? el.closest("[data-kit-control]") ?? el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return [];
      return r.width < 24 || r.height < 24 ? [`${el.getAttribute("aria-label") ?? el.textContent?.trim()}: ${r.width}×${r.height}`] : [];
    }),
  );
  expect(small).toEqual([]);
});

test("every interactive element has an accessible name", async ({ page }) => {
  const nameless = await page.$$eval(INTERACTIVE, (els) =>
    els.flatMap((el) => {
      const byIds = el
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : "";
      const name =
        byIds ||
        el.getAttribute("aria-label")?.trim() ||
        forLabel ||
        el.closest("label")?.textContent?.trim() ||
        el.textContent?.trim() ||
        el.getAttribute("title")?.trim() ||
        "";
      return name ? [] : [el.outerHTML.slice(0, 80)];
    }),
  );
  expect(nameless).toEqual([]);
});

test("the focus ring shows once on everything the keyboard reaches", async ({ page }) => {
  await page.locator("main").click({ position: { x: 2, y: 2 } });
  const seen = new Set<string>();
  const missing: string[] = [];
  const doubled: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const path = (() => {
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node !== document.body) {
          const parent: Element | null = node.parentElement;
          parts.unshift(String(parent ? [...parent.children].indexOf(node) : 0));
          node = parent;
        }
        return parts.join(".");
      })();
      const ringOn = (node: Element | null) => {
        if (!node) return false;
        const s = getComputedStyle(node);
        const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) >= 2;
        return outline;
      };
      const box = el.closest("[data-kit-control]");
      const boxRing = box instanceof HTMLElement && getComputedStyle(box).boxShadow !== "none";
      const visible = ringOn(el) || ringOn(el.closest("label")) || boxRing;
      // A box that draws focus around its input, and the lamp on the input too: two rings.
      const twice = box !== el && boxRing && ringOn(el);
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.labels?.[0]?.textContent?.trim() ?? el.placeholder) : null;
      const what = el.getAttribute("aria-label") || field || el.textContent?.trim().slice(0, 30) || el.tagName;
      return { path, visible, twice, what };
    });
    if (!result) continue;
    if (seen.has(result.path)) break;
    seen.add(result.path);
    if (!result.visible) missing.push(result.what);
    if (result.twice) doubled.push(result.what);
  }
  expect(seen.size).toBeGreaterThan(40);
  expect(missing).toEqual([]);
  expect(doubled).toEqual([]);
});

test("tabs move with the arrow keys, Home and End, and close with Delete", async ({ page }) => {
  const strip = page.getByRole("tablist", { name: "Conversations" });
  const selected = () => strip.locator('[role="tab"][aria-selected="true"]');
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

  await selected().focus();
  await expect(selected()).toHaveAttribute("aria-label", "#listening-room");
  // Only the showing tab is in the tab order.
  await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("ArrowRight");
  await expect(selected()).toHaveAttribute("aria-label", "DM with Jules");
  expect(await focusedLabel()).toBe("DM with Jules");

  await page.keyboard.press("End");
  await expect(selected()).toHaveAttribute("aria-label", "#fotos");
  await page.keyboard.press("Home");
  await expect(selected()).toHaveAttribute("aria-label", "#general");
  await page.keyboard.press("ArrowLeft");
  await expect(selected()).toHaveAttribute("aria-label", "#fotos");
  expect(await focusedLabel()).toBe("#fotos");

  const before = await strip.locator('[role="tab"]').count();
  await page.keyboard.press("Delete");
  await expect(strip.locator('[role="tab"]')).toHaveCount(before - 1);
});

test("a tab dragged along the row lands where it's dropped, and a small wobble is still a click", async ({ page }) => {
  const window = page.getByTestId("tabbed-window");
  const names = () => window.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label")));
  const center = async (name: string) => {
    const box = await window.getByRole("tab", { name, exact: true }).boundingBox();
    if (!box) throw new Error(`no tab ${name}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const before = await names();

  // A press that moves two pixels selects, and moves nothing.
  const general = await center("#general");
  await page.mouse.move(general.x, general.y);
  await page.mouse.down();
  await page.mouse.move(general.x + 2, general.y);
  await page.mouse.up();
  expect(await names()).toEqual(before);
  await expect(window.getByRole("tab", { name: "#general", exact: true })).toHaveAttribute("aria-selected", "true");

  // Dragged past two tabs' middles: it lands after them, and shows.
  const target = await center("DM with Jules");
  await page.mouse.move(general.x, general.y);
  await page.mouse.down();
  await page.mouse.move(general.x + 20, general.y, { steps: 4 });
  // While dragging, the tab follows the pointer and the ones it passes slide aside.
  await page.mouse.move(target.x + 8, target.y, { steps: 8 });
  await expect(window.locator("[data-dragged='yes']")).toHaveCount(1);
  const slid = (name: string) =>
    window.getByRole("tab", { name, exact: true }).evaluate((tab) => new DOMMatrix(getComputedStyle(tab.parentElement ?? tab).transform).m41);
  await expect.poll(() => slid("#listening-room")).toBeLessThan(0);
  await expect.poll(() => slid("DM with Jules")).toBeLessThan(0);
  expect(await slid("#weekend-plans")).toBe(0);
  await page.mouse.up();
  expect(await names()).toEqual(["#listening-room", "DM with Jules", "#general", ...before.slice(3)]);
  await expect(window.getByRole("tab", { name: "#general", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(window.locator("[data-dragged='yes']")).toHaveCount(0);
});

test("a menu opens on its first item, moves with the arrows, and gives focus back when it closes", async ({ page }) => {
  const trigger = page.getByTestId("menu-trigger").getByRole("button", { name: "Actions for Eli's message" });
  const menu = page.getByRole("menu", { name: "Actions for Eli's message" });
  const items = menu.getByRole("menuitem");
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());

  await trigger.click();
  await expect(items).toHaveText(["Reply", "Edit", "Delete"]);
  await expect(items.first()).toBeFocused();
  const heights = await items.evaluateAll((all) => all.map((item) => item.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([32]));
  // Inside the window, below its trigger.
  const [box, button] = [await menu.boundingBox(), await trigger.boundingBox()];
  expect(box && button && box.y >= button.y + button.height && box.x >= 0 && box.x + box.width <= 1280).toBe(true);

  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Edit");
  await page.keyboard.press("End");
  expect(await focused()).toBe("Delete");
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Reply");
  await page.keyboard.press("ArrowUp");
  expect(await focused()).toBe("Delete");

  // A confirm step replaces the items and focuses the first again.
  await page.keyboard.press("Enter");
  await expect(items).toHaveText(["Delete for good", "Keep it"]);
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);

  await trigger.click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("menu-chose")).toHaveText("reply");
});

test("an option list floats below its opener in the kit's rows, shows about six, and a press keeps the focus (#267)", async ({ page }) => {
  const trigger = page.getByTestId("options-trigger").getByRole("button", { name: "Who @ offers" });
  const list = page.getByRole("listbox", { name: "People to mention" });
  const options = list.getByRole("option");

  await trigger.click();
  await expect(options).toHaveCount(13);
  // Below the trigger, its start edge on the trigger's, inside the window (L-11).
  const [box, button] = [await list.boundingBox(), await trigger.boundingBox()];
  expect(box && button && box.y >= button.y + button.height && Math.abs(box.x - button.x) < HALF_PIXEL && box.x + box.width <= 1280).toBe(true);
  // Rows as rows are everywhere: 32px, names starting on one edge.
  const rows = await options.evaluateAll((all) =>
    all.map((one) => ({
      height: one.querySelector(".k-row-main")?.getBoundingClientRect().height,
      x: one.querySelector("[data-kit-row-text]")?.getBoundingClientRect().left,
    })),
  );
  expect(new Set(rows.map((row) => row.height))).toEqual(new Set([32]));
  expect(new Set(rows.map((row) => row.x)).size).toBe(1);
  // About six rows show, and the rest scroll.
  const sizes = await list.evaluate((node) => ({ shown: node.clientHeight, all: node.scrollHeight }));
  expect(sizes.all).toBeGreaterThan(sizes.shown);
  expect(sizes.shown).toBeGreaterThanOrEqual(32 * 6);
  expect(sizes.shown).toBeLessThan(32 * 7);
  // The long name ends in an ellipsis, and its @username stays.
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const long = options.last();
  const cut = await long.evaluate((one) => {
    const title = one.querySelector('[data-kit="Name"]');
    return title ? { over: title.scrollWidth > title.clientWidth, ellipsis: getComputedStyle(title).textOverflow } : null;
  });
  expect(cut).toEqual({ over: true, ellipsis: "ellipsis" });
  await expect(long.locator(".k-row-note")).toBeVisible();

  // One highlighted at a time, and the pointer moves it.
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await options.nth(2).hover();
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);

  // A press chooses and never takes the focus from what opened the list.
  const name = (await options.nth(2).getAttribute("aria-label"))?.split(",")[0] ?? "";
  await trigger.focus();
  await options.nth(2).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("options-chose")).toHaveText(name);
  await expect(list).toHaveCount(0);
});

test("a name inside a sentence sits on the sentence's own lines (inline names)", async ({ page }) => {
  const sentence = page.getByTestId("inline-names");
  const lines = await sentence.locator("span").first().evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    // Which 20px band each piece of text sits in (its middle), from the top.
    const top = span.getBoundingClientRect().top;
    const bands = new Set(
      [...range.getClientRects()].filter((box) => box.width > 0).map((box) => Math.floor((box.top + box.height / 2 - top) / 20)),
    );
    return { count: bands.size, height: span.getBoundingClientRect().height };
  });
  // Every line is the body line's 20px: a name never makes its line taller.
  expect(lines.height).toBe(lines.count * 20);
  const names = await sentence.locator("[data-kit='Name']").evaluateAll((all) => all.map((name) => getComputedStyle(name).display));
  expect(names).toEqual(["inline", "inline", "inline"]);
});

test("tabs lead with a room's # or a person's marker, and a server stripe in a palette color", async ({ page }) => {
  const strip = page.getByRole("tablist", { name: "Conversations" });
  await expect(strip.getByRole("tab", { name: "#general" }).locator(".k-tab-hash")).toHaveText("#");
  await expect(strip.getByRole("tab", { name: "DM with Jules" }).locator("[data-kit='Marker']")).toHaveCount(1);
  const two = page.getByRole("tablist", { name: "Tabs from two servers" });
  const stripes = await two.locator(".k-tab").evaluateAll((tabs) =>
    tabs.map((tab) => {
      const line = getComputedStyle(tab, "::before");
      return { height: line.height, color: line.backgroundColor, key: (tab as HTMLElement).style.getPropertyValue("--tab-stripe") };
    }),
  );
  expect(stripes.map((stripe) => stripe.key)).toEqual(["var(--name-amber)", "var(--name-violet)", "var(--name-amber)"]);
  expect(new Set(stripes.map((stripe) => stripe.height))).toEqual(new Set(["2px"]));
  expect(stripes[0]?.color).toBe(stripes[2]?.color);
  expect(stripes[0]?.color).not.toBe(stripes[1]?.color);
});

test("a list of places moves with the arrow keys, Home and End, with only the showing one in the tab order", async ({ page }) => {
  const nav = page.getByRole("tablist", { name: "Settings sections" });
  const showing = () => nav.getByRole("tab", { selected: true });
  await expect(showing()).toHaveText("Appearance");
  await expect(nav.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await showing().focus();
  await page.keyboard.press("ArrowDown");
  await expect(showing()).toHaveText(/Sound & Voice/);
  await expect(showing()).toBeFocused();
  // Groups are passed over, and the ends wrap.
  await page.keyboard.press("ArrowDown");
  await expect(showing()).toHaveText("Rooms");
  await page.keyboard.press("End");
  await expect(showing()).toHaveText("People");
  await page.keyboard.press("ArrowDown");
  await expect(showing()).toHaveText("Profile");
  await page.keyboard.press("ArrowUp");
  await expect(showing()).toHaveText("People");
  await page.keyboard.press("Home");
  await expect(showing()).toHaveText("Profile");
  await expect(nav.locator('[role="tab"][tabindex="0"]')).toHaveText("Profile");
});

test("an unavailable button looks disabled but keeps the pointer and the keyboard, says why, and a press does nothing (#288)", async ({ page }) => {
  const buttons = page.getByTestId("unavailable-buttons");
  const icons = page.getByTestId("unavailable-icon-buttons");
  const knock = buttons.getByRole("button", { name: "Knock" });
  const icon = icons.getByRole("button", { name: "Can't knock while Jen is offline." });
  const opacity = (locator: ReturnType<Page["locator"]>) => locator.evaluate((node) => getComputedStyle(node).opacity);
  // It looks exactly as a disabled one of its kind does.
  expect(await opacity(knock)).toBe(await opacity(page.locator(".k-button:disabled").first()));
  expect(await opacity(icon)).toBe(await opacity(icons.locator(".k-icon-button:disabled")));
  for (const control of [knock, icon]) {
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("aria-disabled", "true");
  }
  // A button keeps its label as its name and says why as its description;
  // an icon button, whose name is its tooltip, says why as both.
  await expect(knock).toHaveAccessibleDescription("Can't knock while Jen is offline.");
  await expect(buttons.getByRole("button", { name: "Save" })).toHaveAccessibleDescription("Nothing to save yet.");
  // The pointer gets the reason, and no hover look.
  const tip = page.locator("[data-kit='Tooltip']");
  for (const control of [knock, icon]) {
    const before = await control.evaluate((node) => getComputedStyle(node).backgroundColor);
    await control.hover();
    await expect(tip).toHaveText("Can't knock while Jen is offline.");
    expect(await control.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(before);
    await control.click({ force: true });
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
  }
  // The keyboard reaches both, gets the reason too, and Enter does nothing.
  await buttons.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(knock).toBeFocused();
  await expect(tip).toHaveText("Can't knock while Jen is offline.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await icon.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.body.dataset.pressed ?? "")).toBe("");
});

test("a drop-down is named by its label, keeps the choice picked, and a disabled one refuses", async ({ page }) => {
  const size = page.getByRole("combobox", { name: "Interface size" });
  await expect(size).toHaveValue("100");
  await size.selectOption("150");
  await expect(size).toHaveValue("150");
  await expect(page.getByRole("combobox", { name: "Speakers" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Microphone" })).toHaveAccessibleDescription("A change applies at once, in a call too.");
});

test("a slider moves with the keys, says its value in words, and lights the part before the thumb", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "How loud Eli is for you" });
  await expect(slider).toHaveAttribute("aria-valuetext", "150%");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "155%");
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "0%");
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "200%");
  expect(await slider.evaluate((input) => (input as HTMLElement).style.getPropertyValue("--k-slider-lit"))).toBe("100%");
  // As tall as a small control, and as wide as what holds it.
  const box = await slider.boundingBox();
  const holder = await page.getByTestId("slider").boundingBox();
  expect(box?.height).toBe(24);
  expect(box?.width).toBeGreaterThan((holder?.width ?? 0) - 1);
});

test("a slider says once when it's let go of, not on every step (#234)", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "How loud Eli is for you" });
  const holder = page.getByTestId("slider");
  const letGo = async () => ((await holder.getAttribute("data-let-go")) ?? "").split(" ").filter(Boolean).map(Number);
  expect(await letGo()).toEqual([]);

  // A drag: many steps, one let-go, at where it stopped.
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error("no slider");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  for (const share of [0.7, 0.6, 0.5, 0.4, 0.3]) await page.mouse.move(box.x + box.width * share, y);
  await page.mouse.up();
  const dragged = Number(await slider.inputValue());
  expect(dragged).toBeLessThan(1.5);
  expect(await letGo()).toEqual([dragged]);

  // A press that moves nothing says nothing.
  await slider.click({ position: { x: box.width * 0.3, y: box.height / 2 } });
  await page.keyboard.press("Shift");
  expect(await letGo()).toHaveLength(1);

  // A key: one per release. Held down with repeats, it's still one.
  await page.keyboard.press("ArrowRight");
  const stepped = Number(await slider.inputValue());
  expect(stepped).toBeCloseTo(dragged + 0.05, 5);
  expect(await letGo()).toEqual([dragged, stepped]);
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  expect(await letGo()).toHaveLength(2);
  await page.keyboard.up("ArrowRight");
  const held = Number(await slider.inputValue());
  expect(held).toBeCloseTo(stepped + 0.15, 5);
  expect(await letGo()).toEqual([dragged, stepped, held]);

  // A click on the track jumps there, and that's a let-go too.
  await slider.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
  expect(await letGo()).toEqual([dragged, stepped, held, Number(await slider.inputValue())]);
});

test("a wide setting puts its slider on a line of its own, as wide as the row", async ({ page }) => {
  const row = page.locator(".k-setting").filter({ has: page.getByRole("slider", { name: "Sound volume" }) });
  const words = await row.locator(".k-setting-text").boundingBox();
  const slider = await row.getByRole("slider").boundingBox();
  const whole = await row.boundingBox();
  if (!words || !slider || !whole) throw new Error("no row");
  expect(slider.y).toBeGreaterThanOrEqual(words.y + words.height);
  expect(slider.x).toBeCloseTo(words.x, 0);
  expect(slider.width).toBeCloseTo(whole.width, 0);
  expect(slider.height).toBe(24);
});

test("compact choice cards sit side by side with their titles on one line", async ({ page }) => {
  const titles = await page
    .getByRole("group", { name: "Color theme" })
    .locator(".k-choice-title")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(titles).toHaveLength(3);
  expect(new Set(titles).size).toBe(1);
});

test("review sheets: one screenshot per gallery section, for people to look at", async ({ page }) => {
  for (const section of await page.locator("[data-section]").all()) {
    const id = await section.getAttribute("data-section");
    await section.screenshot({ path: `test-results/kit/${test.info().project.name}-${id}.png` });
  }
});

// High contrast (Windows' forced colors): the system repaints backgrounds and
// borders, so every state that was only a color gets a system color (A11Y-6).
test.describe("in high contrast", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("presence dots stay, and every lit state still shows", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
    await page.goto("/tests/fixtures/kit.html");
    const seen = await page.evaluate(() => {
      const style = (selector: string) => {
        const node = document.querySelector(selector);
        return node ? getComputedStyle(node) : null;
      };
      const canvas = getComputedStyle(document.body).backgroundColor;
      // The system's own highlight, as this page would be given it.
      const probe = document.createElement("div");
      probe.style.cssText = "forced-color-adjust: none; background: Highlight";
      document.body.append(probe);
      const highlight = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const dot = style('.k-marker[data-state="here"]');
      const trackOn = style('.k-switch[aria-checked="true"] .k-switch-track');
      const trackOff = style('.k-switch[aria-checked="false"] .k-switch-track');
      const thumbOff = style('.k-switch[aria-checked="false"] .k-switch-thumb');
      return {
        canvas,
        dot: dot?.backgroundColor,
        rowSelected: style('.k-row[data-selected="yes"] .k-row-main')?.outlineStyle,
        rowPlain: style('.k-row:not([data-selected]) .k-row-main')?.outlineStyle,
        tabShowing: style('.k-tab[data-active="yes"]')?.outlineStyle,
        tabOther: style('.k-tab:not([data-active])')?.outlineStyle,
        sectionShowing: style('.k-nav-item[aria-selected="true"]')?.outlineStyle,
        trackOn: trackOn?.backgroundColor,
        trackOff: trackOff?.backgroundColor,
        thumbOff: thumbOff?.backgroundColor,
        talking: style('[data-testid="voice-chips"] .k-chip[data-active="yes"]')?.backgroundColor,
        highlight,
      };
    });
    // A dot isn't the page's own color.
    expect(seen.dot).not.toBe(seen.canvas);
    expect(seen.rowSelected).toBe("solid");
    expect(seen.rowPlain).toBe("none");
    expect(seen.tabShowing).toBe("solid");
    expect(seen.tabOther).toBe("none");
    expect(seen.sectionShowing).toBe("solid");
    expect(seen.trackOn).not.toBe(seen.trackOff);
    expect(seen.thumbOff).not.toBe(seen.trackOff);
    expect(seen.talking).toBe(seen.highlight);

    // The highlighted choice in an option list is outlined, the rest aren't.
    await page.getByTestId("options-trigger").getByRole("button").click();
    const options = page.getByRole("listbox", { name: "People to mention" }).getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    const outline = (option: typeof options) => option.locator(".k-row-main").evaluate((node) => getComputedStyle(node).outlineStyle);
    expect(await outline(options.first())).toBe("solid");
    expect(await outline(options.nth(1))).toBe("none");
  });
});

test("a splitter moves with the pointer and the keys, stays between its ends, and Enter puts it back (#337)", async ({ page }) => {
  const split = page.getByTestId("split");
  const line = split.getByRole("separator", { name: "Width of the list" });
  await line.scrollIntoViewIfNeeded();
  await expect(line).toHaveAttribute("aria-valuenow", "200");
  await expect(line).toHaveAttribute("aria-orientation", "vertical");
  // Drawn as a hairline, and taken a little either side of it: its whole
  // length, and 8px across besides the line.
  const box = await line.boundingBox();
  expect(box?.width).toBe(1);
  const takes = await page.evaluate(
    ({ x, y }) => [-7, -3, 3, 7].map((dx) => document.elementFromPoint(x + dx, y)?.getAttribute("data-kit") === "Splitter"),
    { x: box?.x ?? 0, y: (box?.y ?? 0) + 60 },
  );
  expect(takes).toEqual([false, true, true, false]);
  await page.mouse.move((box?.x ?? 0) + 3, (box?.y ?? 0) + 60);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 63, (box?.y ?? 0) + 60, { steps: 4 });
  await page.mouse.up();
  await expect(line).toHaveAttribute("aria-valuenow", "260");
  await expect(split).toContainText("The list, 260 wide");
  // Never past its ends, however far it's dragged.
  const now = await line.boundingBox();
  await page.mouse.move((now?.x ?? 0), (now?.y ?? 0) + 60);
  await page.mouse.down();
  await page.mouse.move((now?.x ?? 0) + 500, (now?.y ?? 0) + 60, { steps: 4 });
  await page.mouse.up();
  await expect(line).toHaveAttribute("aria-valuenow", "360");
  await line.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveAttribute("aria-valuenow", "340");
  await page.keyboard.press("Home");
  await expect(line).toHaveAttribute("aria-valuenow", "120");
  await page.keyboard.press("End");
  await expect(line).toHaveAttribute("aria-valuenow", "360");
  await page.keyboard.press("Enter");
  await expect(line).toHaveAttribute("aria-valuenow", "200");
});

