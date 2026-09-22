import { expect, test } from "@playwright/test";

test("shared states distinguish mute, deafen and legacy clients", async ({ page }) => {
  await page.goto("/tests/fixtures/voice.html");
  await expect(page.getByRole("listitem").filter({ hasText: "Muted friend" })).toContainText("muted");
  await expect(page.getByRole("listitem").filter({ hasText: "Deafened friend" })).toContainText("deafened");
  await expect(page.getByRole("listitem").filter({ hasText: "Legacy friend" })).toContainText("mic state unknown");
});

test("deafen disables unmute and restores the prior microphone choice", async ({ page }) => {
  await page.goto("/tests/fixtures/voice.html");
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  for (const priorMuted of [false, true]) {
    if (priorMuted) await page.getByRole("button", { name: "Mute", exact: true }).click();
    await page.getByRole("button", { name: "Deafen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Muted", exact: true })).toBeDisabled();
    await expect(page.locator("html")).toHaveAttribute("data-controls", '{"muted":true,"deafened":true}');
    await page.getByRole("button", { name: "Undeafen", exact: true }).click();
    await expect(page.getByRole("button", { name: priorMuted ? "Muted" : "Mute", exact: true })).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("data-controls", JSON.stringify({ muted: priorMuted, deafened: false }));
  }
});

test("push-to-talk cannot reopen a deafened mic and needs a new press after undeafen", async ({ page }) => {
  await page.goto("/tests/fixtures/voice.html?ptt");
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  await page.keyboard.down("Control");
  await expect(page.locator("html")).toHaveAttribute("data-controls", '{"muted":false,"deafened":false}');
  await page.getByRole("button", { name: "Deafen", exact: true }).click();
  await page.keyboard.up("Control");
  await page.keyboard.down("Control");
  await expect(page.locator("html")).toHaveAttribute("data-controls", '{"muted":true,"deafened":true}');
  await page.getByRole("button", { name: "Undeafen", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-controls", '{"muted":true,"deafened":false}');
  await page.keyboard.up("Control");
  await page.keyboard.down("Control");
  await expect(page.locator("html")).toHaveAttribute("data-controls", '{"muted":false,"deafened":false}');
  await page.keyboard.up("Control");
});

test("failed controls disconnect voice and display the failure", async ({ page }) => {
  await page.goto("/tests/fixtures/voice.html");
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.refuse = "yes"; });
  await page.getByRole("button", { name: "Deafen", exact: true }).click();
  await expect(page.getByText(/Couldn't change voice controls/)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-left", "yes");
});
