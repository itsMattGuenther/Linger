import { expect, test } from "@playwright/test";

// A window that can't be drawn (#509): the last boundary, at the window's
// root, as main.tsx draws every window (tests/fixtures/next-boundary.tsx).
// Each pane's own boundary, which catches first, is proved in the real list
// window (next-side.spec.ts).

test.use({ viewport: { width: 340, height: 600 } });

test("a window that can't be drawn says so under its title bar, with Reload, and tells nobody but this computer's console", async ({ page, baseURL }) => {
  await page.goto("/tests/fixtures/next-boundary.html");
  await expect(page.getByText("Drawing fine.")).toBeVisible();
  const asked: string[] = [];
  page.on("request", (request) => asked.push(`${request.method()} ${request.url()}`));
  const logged: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") logged.push(message.text());
  });
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(error.message));

  await page.evaluate(() => window.boundary?.breakIt());
  const said = page.getByRole("status");
  await expect(said).toContainText("This window couldn't be shown.");
  await expect(said).toContainText("Reloading usually brings it back.");
  // Still a window: its title bar, to move it and close it.
  await expect(page.locator(".k-titlebar")).toContainText("Linger");
  // Caught, not thrown on: what broke is in this computer's console, and
  // nothing went anywhere else (AGENTS.md, hard rule 4).
  await expect.poll(() => logged.some((text) => text.includes("A drawing bug, on purpose"))).toBe(true);
  expect(uncaught).toEqual([]);
  expect(asked.filter((request) => !request.startsWith(`GET ${baseURL}/`))).toEqual([]);

  // Reload starts the window over.
  await Promise.all([page.waitForEvent("load"), said.getByRole("button", { name: "Reload" }).click()]);
  await expect(page.getByText("Drawing fine.")).toBeVisible();
  await expect(page.getByText("This window couldn't be shown.")).toHaveCount(0);
});
