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

test("review sheets: one screenshot per gallery section, for people to look at", async ({ page }) => {
  for (const section of await page.locator("[data-section]").all()) {
    const id = await section.getAttribute("data-section");
    await section.screenshot({ path: `test-results/kit/${test.info().project.name}-${id}.png` });
  }
});
