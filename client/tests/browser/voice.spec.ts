import { expect, test } from "@playwright/test";

test("shared states distinguish mute, deafen and legacy clients", async ({ page }) => {
  await page.goto("/tests/fixtures/voice.html");
  // Muted and deafened are the controls' glyphs, not words: the word is only
  // for screen readers and the tooltip.
  for (const [who, state] of [["Muted friend", "Muted"], ["Deafened friend", "Deafened"]] as const) {
    const seat = page.getByRole("listitem").filter({ hasText: who });
    const icon = seat.locator(".voice-state-icon");
    await expect(icon).toHaveAttribute("title", state);
    await expect(icon.locator("svg")).toBeVisible();
    await expect(icon.locator(".sr-only")).toHaveText(state);
    await expect(seat.locator(".meta")).toHaveCount(0);
  }
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
