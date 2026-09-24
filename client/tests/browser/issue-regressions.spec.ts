import { expect, test } from "@playwright/test";

for (const dm of [false, true]) {
  test(`Enter clears immediately and preserves the next draft in ${dm ? "DM" : "room"} (#117)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html?sending");
    if (dm) await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
    const box = page.locator(".composer-input");
    await page.evaluate(() => { document.documentElement.dataset.holdSend = "yes"; });
    await box.fill("First message");
    await box.press("Enter");
    await expect(box).toBeEmpty();
    await expect(box).toBeFocused();
    await box.pressSequentially("Next draft");
    await expect(page.locator("html")).toHaveAttribute("data-last-sent", /First message/);
    await page.evaluate(() => document.dispatchEvent(new Event("finish-send")));
    await expect(page.getByRole("status").filter({ hasText: "Sending…" })).toHaveCount(0);
    await expect(box).toHaveValue("Next draft");
    await box.press("Shift+Enter");
    await box.pressSequentially("second line");
    await expect(box).toHaveValue("Next draft\nsecond line");
  });
}

test("failed sends restore text and preserve a newer draft separately (#117, #118)", async ({ page }) => {
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
  await box.fill("A newer draft");
  await box.press("Enter");
  await expect(page.getByText(/previous message is still sending/)).toBeVisible();
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

for (const dm of [false, true]) {
  test(`typing in a multi-line ${dm ? "DM" : "room"} draft leaves the box and stream still (#127)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html?history&sending");
    if (dm) await page.locator(".rail-dms").getByRole("button", { name: "Jules", exact: true }).click();
    const box = page.locator(".composer-input");
    const stream = page.locator(".stream-body");
    await page.evaluate(() => document.fonts.ready);
    await box.fill("first line\nsecond line\n");
    const gap = () => stream.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
    await expect.poll(gap).toBeLessThanOrEqual(2);
    // Wait out the stream's own landing, which re-aims for a few frames.
    await stream.evaluate((node) => new Promise<void>((resolve) => {
      let quiet = window.setTimeout(resolve, 500);
      node.addEventListener("scroll", () => {
        window.clearTimeout(quiet);
        quiet = window.setTimeout(resolve, 500);
      });
    }));
    const height = (await box.boundingBox())?.height;
    // Measuring by collapsing the real box rewrote its height twice per key and
    // moved the stream above it; typing inside a line should do neither.
    await page.evaluate(() => {
      const record = { scrolls: 0, heights: 0 };
      (window as unknown as { typing: typeof record }).typing = record;
      document.querySelector(".stream-body")?.addEventListener("scroll", () => { record.scrolls += 1; });
      new MutationObserver((changes) => { record.heights += changes.length; })
        .observe(document.querySelector(".composer-input")!, { attributes: true, attributeFilter: ["style"] });
    });
    await box.pressSequentially("third line keeps up");
    await expect(box).toHaveValue("first line\nsecond line\nthird line keeps up");
    const record = await page.evaluate(() => (window as unknown as { typing: { scrolls: number; heights: number } }).typing);
    expect(record).toEqual({ scrolls: 0, heights: 0 });
    expect((await box.boundingBox())?.height).toBe(height);
    expect(await gap()).toBeLessThanOrEqual(2);
  });
}

test("the composer and the edit box grow and shrink with their lines (#127)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html");
  const box = page.locator(".composer-input");
  await page.evaluate(() => document.fonts.ready);
  const heightOf = async (node: import("@playwright/test").Locator) => (await node.boundingBox())?.height ?? 0;
  await box.fill("one");
  const single = await heightOf(box);
  await box.fill("one\ntwo\nthree");
  await expect.poll(() => heightOf(box)).toBeGreaterThan(single);
  await box.fill("one");
  await expect.poll(() => heightOf(box)).toBe(single);

  await box.fill("");
  await box.press("ArrowUp");
  const edit = page.getByRole("textbox", { name: "edit this message" });
  await expect(edit).toBeFocused();
  const original = await edit.inputValue();
  const before = await heightOf(edit);
  // The box shows all of the message: nothing hidden behind its own scrollbar.
  expect(await edit.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  await edit.press("Shift+Enter");
  await edit.pressSequentially("another line");
  await expect(edit).toHaveValue(`${original}\nanother line`);
  await expect.poll(() => heightOf(edit)).toBeGreaterThan(before);
  for (let i = 0; i < "\nanother line".length; i++) await edit.press("Backspace");
  await expect(edit).toHaveValue(original);
  await expect.poll(() => heightOf(edit)).toBe(before);
});
