import { expect, type Locator, type Page, test } from "@playwright/test";

// The buttons Linger draws on its own title bars (#386). Every window is
// frameless, so the desktop draws none. On Windows, where every window has a
// minimize button, each of Linger's has one just before its close button,
// and it minimizes that window. On Linux there's none: a tiling desktop has
// no minimizing (core/windowControls.ts).

/** Windows: WebView2, as the packaged app reports itself. */
const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
/** Linux: WebKitGTK, as the packaged app reports itself. */
const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";

/** Everything the window asked of the shell, in order. */
async function did(page: Page): Promise<string[]> {
  return ((await page.locator("body").getAttribute("data-did")) ?? "").split("|").filter(Boolean);
}

/** The names of a title bar's buttons, left to right. */
async function buttons(bar: Locator): Promise<string[]> {
  return bar.getByRole("button").evaluateAll((all) => all.map((one) => one.getAttribute("aria-label") ?? one.textContent ?? ""));
}

const WINDOWS: { name: string; open: (page: Page) => Promise<Locator>; asked: string }[] = [
  {
    name: "the list",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-list-window.html?one");
      await expect(page.locator("[data-screen='list']")).toBeVisible();
      return page.locator(".k-titlebar");
    },
    asked: "minimize",
  },
  {
    name: "the list with a conversation beside it",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-list-window.html?one");
      await page.getByRole("list", { name: "Rooms" }).getByRole("button").first().click();
      await expect(page.getByRole("tab", { selected: true })).toBeVisible();
      await expect(page.locator(".k-titlebar")).toHaveCount(2);
      // The list's own bar, on the left, has neither: they're on the far right.
      await expect(page.locator(".k-titlebar").first().getByRole("button", { name: "Minimize" })).toHaveCount(0);
      return page.locator(".k-titlebar").last();
    },
    asked: "minimize",
  },
  {
    name: "signing in",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-list-window.html?one&signedout");
      await expect(page.getByRole("textbox", { name: "Server or link" })).toBeVisible();
      return page.locator(".k-titlebar");
    },
    asked: "minimize",
  },
  {
    name: "a conversation in a window of its own",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-chat-window.html?room=r-general");
      await expect(page.locator(".nx-pane")).toBeVisible();
      return page.locator(".k-titlebar");
    },
    asked: "window:minimize",
  },
  {
    name: "Settings",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-settings-window.html");
      await expect(page.getByRole("tabpanel")).toBeVisible();
      return page.locator(".k-titlebar");
    },
    asked: "window:minimize",
  },
  {
    name: "Search",
    open: async (page) => {
      await page.goto("/tests/fixtures/next-tool-window.html?which=search");
      await expect(page.locator("[data-screen='search-window']")).toBeVisible();
      return page.locator(".k-titlebar");
    },
    asked: "window:minimize",
  },
];

test.describe("on Windows", () => {
  test.use({ userAgent: WEBVIEW2 });

  for (const window of WINDOWS) {
    test(`${window.name} has a minimize button just before its close button, and it minimizes the window (#386)`, async ({ page }) => {
      const bar = await window.open(page);
      expect((await buttons(bar)).slice(-2)).toEqual(["Minimize", "Close window"]);
      await bar.getByRole("button", { name: "Minimize" }).click();
      await expect.poll(() => did(page)).toContain(window.asked);
    });
  }
});

test.describe("on Linux", () => {
  test.use({ userAgent: WEBKITGTK });

  for (const window of WINDOWS) {
    test(`${window.name} has no minimize button, since a tiling desktop can't minimize (#386)`, async ({ page }) => {
      const bar = await window.open(page);
      expect((await buttons(bar)).at(-1)).toBe("Close window");
      await expect(page.getByRole("button", { name: "Minimize" })).toHaveCount(0);
    });
  }
});
