import { expect, type Locator, type Page, test } from "@playwright/test";
import { installTauriDrag } from "./tauri-drag";

// Moving a window by its title bar. Every new-client window is frameless and
// draws its own bar (docs/design/system.md, TitleBar), so a press anywhere
// on the bar but a control has to move the window, or on Windows and GNOME
// nothing does. The desktop shell's rule for which presses move a window is
// Tauri's, copied into the page by `tauri-drag.ts`.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriDrag);
});

async function drags(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.tauriDrags ?? [])]);
}

async function rect(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

/**
 * Every place on a title bar, every 4px, where a press does the wrong thing:
 * off the controls it doesn't move the window, or on a control it does.
 * Named by what's under the pointer, so a failure says which part is dead.
 */
async function wrongPresses(bar: Locator): Promise<string[]> {
  return bar.evaluate((header) => {
    const CONTROL = 'button, a, input, select, textarea, [role="tab"], [tabindex]:not([tabindex="-1"]), .k-tab';
    const box = header.getBoundingClientRect();
    const wrong = new Map<string, number>();
    for (let y = box.top + 1; y < box.bottom - 1; y += 4) {
      for (let x = box.left + 1; x < box.right - 1; x += 4) {
        const under = document.elementFromPoint(x, y);
        if (!under || !header.contains(under)) continue;
        const control = under.closest(CONTROL);
        const onControl = control !== null && header.contains(control);
        const moves = window.tauriMoves?.(under) ?? false;
        if (onControl !== moves) continue;
        const name = `<${under.tagName.toLowerCase()} class="${under.getAttribute("class") ?? ""}"> ${moves ? "moves the window" : "does nothing"}`;
        wrong.set(name, (wrong.get(name) ?? 0) + 1);
      }
    }
    return [...wrong].map(([name, count]) => `${name} (${count} places)`);
  });
}

test("the tabs window moves by any part of its title bar that isn't a tab or a button (#225)", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 790 });
  await page.goto("/tests/fixtures/next-chat.html");
  const bar = page.locator(".k-titlebar");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);

  const title = await rect(bar);
  const last = await rect(page.locator(".k-tab").last());
  const popOut = await rect(page.getByRole("button", { name: "Open in its own window" }));
  const showing = await rect(page.locator(".k-tab[data-active='yes']"));
  const middle = title.y + title.height / 2;
  expect(popOut.x - (last.x + last.width), "room after the last tab").toBeGreaterThan(40);

  // After the last tab, above the showing tab, and just before the buttons.
  await page.mouse.click(last.x + last.width + 20, middle);
  await page.mouse.click(showing.x + showing.width / 2, title.y + 2);
  await page.mouse.click(popOut.x - 3, middle);
  expect(await drags(page)).toEqual(["start_dragging", "start_dragging", "start_dragging"]);
  // A double press there maximizes, as a system title bar does.
  await page.mouse.dblclick(last.x + last.width + 20, middle);
  expect(await drags(page)).toEqual(["start_dragging", "start_dragging", "start_dragging", "start_dragging", "internal_toggle_maximize"]);

  // Tabs and buttons stay theirs: a press on a tab shows it, the pop-out
  // button pops out, and neither moves the window.
  const before = (await drags(page)).length;
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Open in its own window" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-did", /popout:/);
  expect((await drags(page)).length).toBe(before);
});

test.describe("every title bar moves its window from anywhere but its controls", () => {
  test("in the kit: plain titles, tabs, marks, actions and Windows' minimize", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/tests/fixtures/kit.html");
    const bars = page.locator("[data-section='tabs'] .k-titlebar");
    await expect(bars).toHaveCount(5);
    for (const bar of await bars.all()) expect(await wrongPresses(bar)).toEqual([]);
  });

  test("the chat window, with tabs", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 790 });
    await page.goto("/tests/fixtures/next-chat.html");
    await expect(page.getByRole("tab")).toHaveCount(4);
    expect(await wrongPresses(page.locator(".k-titlebar"))).toEqual([]);
  });

  test("a conversation in its own window, its header in the title bar", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 760 });
    await page.route("https://good-company.example/media/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
    await page.goto("/tests/fixtures/next-chat-window.html?room=r-general&single=1");
    await expect(page.getByRole("region", { name: "#general" })).toBeVisible();
    await expect(page.locator(".k-titlebar .nx-pane-head")).toBeVisible();
    expect(await wrongPresses(page.locator(".k-titlebar"))).toEqual([]);
  });

  test("the list and Settings", async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 820 });
    await page.goto("/tests/fixtures/next-list.html");
    await expect(page.locator(".k-titlebar")).toBeVisible();
    expect(await wrongPresses(page.locator(".k-titlebar"))).toEqual([]);

    await page.setViewportSize({ width: 720, height: 640 });
    await page.goto("/tests/fixtures/next-settings.html");
    await expect(page.locator(".k-titlebar")).toBeVisible();
    expect(await wrongPresses(page.locator(".k-titlebar"))).toEqual([]);
  });
});
