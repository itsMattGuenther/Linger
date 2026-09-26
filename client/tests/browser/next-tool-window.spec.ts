import { expect, type Page, test } from "@playwright/test";

// The real Search and Media windows (decision 15), wired: the desktop shell,
// the list window and the server faked in the page
// (tests/fixtures/next-tool-window.tsx). The views themselves are measured in
// next-search.spec.ts and next-media.spec.ts; this is about the wiring.

const SERVER = "https://good-company.example";

async function open(page: Page, which: "search" | "media", extra = "") {
  await page.goto(`/tests/fixtures/next-tool-window.html?which=${which}${extra}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(`[data-screen='${which}-window']`)).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return ((await page.locator("body").getAttribute("data-did")) ?? "").split("|").filter(Boolean);
}

function intents(asked: string[]): Record<string, unknown>[] {
  return asked.filter((line) => line.startsWith("intent:")).map((line) => JSON.parse(line.slice("intent:".length)) as Record<string, unknown>);
}

test.describe("the Search window", () => {
  test.use({ viewport: { width: 560, height: 680 } });

  test("asks the server with the list window's sign-in, and a hit opens its conversation at the message", async ({ page }) => {
    await open(page, "search");
    await expect(page.getByRole("textbox", { name: "Search", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("porch");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await did(page)).some((line) => line.startsWith("GET /search?q=porch") && line.endsWith("as token-1"))).toBe(true);
    const first = page.locator(".nx-hit-main").first();
    await expect(first).toBeVisible();
    await first.click();
    await expect
      .poll(async () => intents(await did(page)).find((intent) => intent.kind === "open"))
      .toMatchObject({ kind: "open", server: SERVER, conversation: expect.stringMatching(/^(room|dm)$/), messageId: expect.any(String) });
    // The room kind comes from what this window holds: a DM hit opens as a DM.
    const opened = intents(await did(page)).find((intent) => intent.kind === "open");
    expect(opened?.conversation).toBe(String(opened?.roomId).startsWith("d-") ? "dm" : "room");
  });

  test("Ctrl+K puts the cursor back in the box, and Ctrl+, opens Settings", async ({ page }) => {
    await open(page, "search");
    const box = page.getByRole("textbox", { name: "Search", exact: true });
    await box.fill("porch");
    await box.blur();
    await expect(box).not.toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused();
    await page.keyboard.press("Control+,");
    await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "settings" });
    // Search is already here: Ctrl+K never asks for another.
    expect(intents(await did(page)).filter((intent) => intent.kind === "tool")).toEqual([]);
  });

  test("counts towards you being here, like any Linger window", async ({ page }) => {
    await open(page, "search");
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("moon");
    await expect.poll(async () => intents(await did(page)).some((intent) => intent.kind === "window")).toBe(true);
  });
});

test.describe("the Media window", () => {
  test.use({ viewport: { width: 780, height: 680 } });

  test("loads the collection, stars through the server, and a tile opens its message", async ({ page }) => {
    await open(page, "media");
    await expect.poll(async () => (await did(page)).some((line) => line.startsWith("GET /media?limit=") && line.endsWith("as token-1"))).toBe(true);
    const tiles = page.locator(".nx-tile-open");
    await expect(tiles.first()).toBeVisible();
    const speakers = page.locator(".nx-tile", { has: page.locator(".nx-tile-title", { hasText: "speakers.png" }) });
    await speakers.getByRole("button", { name: /^Star/ }).click();
    await expect.poll(async () => (await did(page)).some((line) => /^PUT \/media\/[^/]+\/star as token-1$/.test(line))).toBe(true);
    // Ctrl+K from Media brings Search up.
    await page.keyboard.press("Control+k");
    await expect.poll(async () => intents(await did(page))).toContainEqual({ kind: "tool", which: "search" });
    await speakers.locator(".nx-tile-open").click();
    await expect.poll(async () => intents(await did(page)).find((intent) => intent.kind === "open")).toMatchObject({
      kind: "open",
      server: SERVER,
      roomId: "r-general",
      conversation: "room",
      messageId: "m000007",
    });
  });
});
