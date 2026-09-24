import { expect, test, type Page } from "@playwright/test";

/**
 * The fixture's `holdSend` mock records which sends it is currently holding
 * open. Firing a "finish-send" event before a send has reached that point
 * releases into nothing — a `{once: true}` listener that misses its event
 * never gets another chance at it — so a test with more than one send in
 * flight has to wait for all of them to actually be held first.
 */
async function waitForHeld(page: Page, ...bodies: string[]): Promise<void> {
  const held = () =>
    page.evaluate(() => JSON.parse(document.documentElement.dataset.sendsHeld ?? "[]") as string[]);
  await expect.poll(async () => (await held()).slice().sort()).toEqual(bodies.slice().sort());
}

for (const dm of [false, true]) {
  test(`Enter clears immediately, shows the message before it is confirmed, and preserves the next draft in ${dm ? "DM" : "room"} (#117, #128)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html?sending");
    if (dm) await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
    const box = page.locator(".composer-input");
    await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
    await box.fill("First message");
    await box.press("Enter");
    await expect(box).toBeEmpty();
    await expect(box).toBeFocused();
    // Shown right away — sending does not wait on the server's answer.
    const row = page.locator(".msg", { hasText: "First message" });
    await expect(row).toHaveAttribute("data-pending", "true");
    await expect(row.locator(".msg-actions-trigger")).toHaveCount(0);
    await box.pressSequentially("Next draft");
    await expect(page.locator("html")).toHaveAttribute("data-last-sent", /First message/);
    await waitForHeld(page, "First message");
    await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
    await expect(row).not.toHaveAttribute("data-pending", "true");
    await expect(row.locator(".msg-actions-trigger")).toHaveCount(1);
    await expect(box).toHaveValue("Next draft");
    await box.press("Shift+Enter");
    await box.pressSequentially("second line");
    await expect(box).toHaveValue("Next draft\nsecond line");
  });
}

test("failed sends restore text, or keep a draft already being typed, untouched (#117, #118)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.refuseSend = "yes"; });
  await box.fill("Keep this text");
  await box.press("Enter");
  await expect(box).toHaveValue("Keep this text");
  await expect(page.getByText("This message was refused.")).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.press("Enter");
  await expect(box).toBeEmpty();
  // A draft typed while that retry is still open — not a second send, just
  // text sitting in the box — must not be touched by how the retry resolves.
  await box.fill("A newer draft");
  await waitForHeld(page, "Keep this text");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
  await expect(page.locator(".composer-unsent-text")).toHaveText("Keep this text");
  await expect(box).toHaveValue("A newer draft");
  await page.evaluate(() => { delete document.documentElement.dataset.holdSend; delete document.documentElement.dataset.refuseSend; });
  await page.getByRole("button", { name: "Retry unsent message" }).click();
  await expect(page.locator(".composer-unsent")).toHaveCount(0);
  await expect(box).toHaveValue("A newer draft");
  await box.press("Enter");
  await expect(box).toBeEmpty();
});

test("a second message can be sent before the first is confirmed, in submission order (#128)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.fill("Alpha");
  await box.press("Enter");
  await expect(box).toBeEmpty();
  await box.fill("Beta");
  await box.press("Enter");
  await expect(box).toBeEmpty();
  const bodies = page.locator(".msg-body");
  await expect(bodies.nth(-2)).toHaveText("Alpha");
  await expect(bodies.last()).toHaveText("Beta");
  await waitForHeld(page, "Alpha", "Beta");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
  await expect(page.locator('.msg[data-pending="true"]')).toHaveCount(0);
});

test("whichever send confirms first settles ahead of one still pending, and the order holds once both land (#128)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.fill("Gamma");
  await box.press("Enter");
  await box.fill("Delta");
  await box.press("Enter");
  const bodies = page.locator(".msg-body");
  // Typed and shown in that order, both still unconfirmed.
  await expect(bodies.nth(-2)).toHaveText("Gamma");
  await expect(bodies.last()).toHaveText("Delta");
  await waitForHeld(page, "Gamma", "Delta");
  // Delta's answer comes back first — it settles ahead of the still-pending
  // Gamma, because a confirmed message is never shown behind an unconfirmed
  // one. This is the one place the order you sent in and the order shown can
  // legitimately differ.
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send:Delta")));
  await expect(bodies.nth(-2)).toHaveText("Delta");
  await expect(bodies.last()).toHaveText("Gamma");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send:Gamma")));
  await expect(bodies.nth(-2)).toHaveText("Delta");
  await expect(bodies.last()).toHaveText("Gamma");
  await expect(page.locator('.msg[data-pending="true"]')).toHaveCount(0);
});

test("a send's own live announcement arriving early never leaves a duplicate on screen (#128)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.fill("Solo delivery check");
  await box.press("Enter");
  // The fixture's own answer to this send announces the confirmed message
  // over the socket before it lets the POST itself return — the same order a
  // real server can produce. Nothing should ever show it twice.
  await expect(page.locator(".msg-body", { hasText: "Solo delivery check" })).toHaveCount(1);
  await waitForHeld(page, "Solo delivery check");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
  await expect(page.locator(".msg-body", { hasText: "Solo delivery check" })).toHaveCount(1);
  await expect(page.locator(".msg", { hasText: "Solo delivery check" })).not.toHaveAttribute("data-pending", "true");
});

test("sending the same text twice settles as two separate messages, not one or three (#128)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.fill("Twin message");
  await box.press("Enter");
  await box.fill("Twin message");
  await box.press("Enter");
  const twins = page.locator(".msg-body", { hasText: "Twin message" });
  await expect(twins).toHaveCount(2);
  await expect(page.locator('.msg[data-pending="true"]', { hasText: "Twin message" })).toHaveCount(2);
  await waitForHeld(page, "Twin message", "Twin message");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
  await expect(twins).toHaveCount(2);
  await expect(page.locator('.msg[data-pending="true"]', { hasText: "Twin message" })).toHaveCount(0);
});

test("nothing labeled Sending ever appears in the composer while a send is open (#129)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  const box = page.locator(".composer-input");
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  await box.fill("Checking the composer stays clear");
  await box.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Sending" })).toHaveCount(0);
  await expect(page.locator(".meta", { hasText: "Sending" })).toHaveCount(0);
  await expect(box).toBeVisible();
  await waitForHeld(page, "Checking the composer stays clear");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
});

test("stalled send times out visibly and Enter recovers (#118)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  await page.clock.install();
  await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
  const box = page.locator(".composer-input");
  await box.fill("Unconfirmed message");
  await box.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-last-sent", /Unconfirmed/);
  await page.clock.runFor(30_010);
  await expect(page.getByText(/server did not confirm/)).toBeVisible();
  await expect(box).toHaveValue("Unconfirmed message");
  await page.evaluate(() => { delete document.documentElement.dataset.holdSend; });
  await box.fill("Another message");
  await box.press("Enter");
  await expect(box).toBeEmpty();
});

test("quotes follow the sender and deleted replies lose only their quote (#115, #116)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?replies");
  await expect(page.locator(".msg-reply")).toHaveCount(3);
  const first = page.locator(".msg-reply").first().locator("..");
  await expect(page.locator(".msg-reply").nth(1).locator("..").locator(".msg-head")).toHaveCount(0);
  const positions = await first.evaluate((node) => {
    const head = node.querySelector(".msg-head")!.getBoundingClientRect();
    const quote = node.querySelector(".msg-reply")!.getBoundingClientRect();
    const body = node.querySelector(".msg-body")!.getBoundingClientRect();
    return [head.bottom, quote.top, quote.bottom, body.top];
  });
  expect(positions[1]).toBeGreaterThanOrEqual(positions[0]!);
  expect(positions[3]).toBeGreaterThanOrEqual(positions[2]!);
  await first.hover();
  await first.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: /delete/i }).click();
  await page.getByRole("menuitem", { name: "delete for good" }).click();
  await expect(page.locator(".msg-reply")).toHaveCount(2);
  await expect(page.locator(".msg-gone")).toHaveCount(1);
  await expect(page.locator(".msg-reply").last()).toContainText("deleted");
});

for (const dm of [false, true]) {
  test(`${dm ? "DM" : "room"} opens at the saved boundary without a catch-up band (#123)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html?catchup");
    if (dm) await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
    const boundary = page.locator(".left-off");
    await expect(boundary).toBeInViewport();
    await expect(page.getByRole("button", { name: "since you were gone" })).toHaveCount(0);
    await expect(page.locator(".since")).toHaveCount(0);
    const before = await boundary.boundingBox();
    await page.evaluate(() => document.dispatchEvent(new Event("fixture-message")));
    await expect(boundary).toBeInViewport();
    const after = await boundary.boundingBox();
    expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThan(3);
    await page.getByRole("button", { name: "back to the newest" }).click();
    await expect(page.locator(".msg-body").last()).toContainText("A new arrival");
    await expect(page.locator("html")).toHaveAttribute("data-read-marker", /message-00300/);
    await expect(page.getByRole("button", { name: "back to the newest" })).toHaveCount(0);
  });
}

for (const theme of ["dark", "light"]) {
  test(`voice names carry speech and failure in ${theme} (#121, #124)`, async ({ page }) => {
    await page.goto("/tests/fixtures/voice.html");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Join Voice", exact: true }).click();
    await page.evaluate(() => document.dispatchEvent(new Event("fixture-seats")));
    await expect(page.getByRole("button", { name: "Matt, you, voice options" })).toBeVisible();
    await expect(page.getByText("you", { exact: true })).toHaveCount(0);
    const failed = page.locator('.voice-seat[data-link="failed"]');
    await expect(failed).toContainText("can't reach");
    const shape = await failed.evaluate((node) => {
      const name = node.querySelector(".voice-name")!, state = node.querySelector(".voice-seat-state")!;
      const n = name.getBoundingClientRect(), s = state.getBoundingClientRect();
      return { gap: Math.abs(n.x + n.width / 2 - s.x - s.width / 2),
        whitespace: getComputedStyle(state.firstElementChild!).whiteSpace,
        thickness: getComputedStyle(name).textDecorationThickness };
    });
    expect(shape.gap).toBeLessThan(1);
    expect(shape.whitespace).toBe("nowrap");
    expect(shape.thickness).toBe("2px");
    await expect(page.locator('[data-talking="true"] .voice-name')).toHaveCSS("font-weight", "700");
    await expect(page.locator('[data-talking="true"] .voice-name')).toHaveCSS("text-decoration-line", "underline");
  });
}

test("a search jump wins over the saved room boundary (#123)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?catchup");
  await expect(page.locator(".left-off")).toBeInViewport();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "search", exact: true }).fill("History");
  await page.locator(".search-hit").first().click();
  await expect(page.locator('.msg[data-flash="true"]')).toContainText("History sample 180");
  await expect(page.locator('.msg[data-flash="true"]')).toBeInViewport();
});

test("second knock settles and closing the profile leaves room and DM sending usable (#118)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?sending");
  await page.locator(".roster").getByRole("button", { name: /Jules/ }).click();
  const panel = page.getByRole("dialog", { name: "Jules's profile", exact: true });
  await panel.getByRole("button", { name: "Knock", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Knocked", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Knock", exact: true })).toBeEnabled({ timeout: 5000 });
  await page.evaluate(() => { document.documentElement.dataset.holdKnock = "yes"; });
  await panel.getByRole("button", { name: "Knock", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Knocking…" })).toBeDisabled();
  await panel.getByRole("button", { name: "Knocking…" }).dispatchEvent("click");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-knock")));
  await expect(panel.getByRole("button", { name: "Knocked", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const dm of [false, true]) {
    if (dm) await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
    const box = page.locator(".composer-input");
    await box.fill(dm ? "DM after knock" : "Room after knock");
    await box.press("Enter");
    await expect(box).toBeEmpty();
    await expect(page.locator("html")).toHaveAttribute("data-last-sent", dm ? /DM after knock/ : /Room after knock/);
  }
});
