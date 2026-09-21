import { expect, test } from "@playwright/test";

test("reactions acknowledge accepted local actions, never loaded or remote ones", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const mark = page.getByRole("button", { name: /^heart,/ });
  const row = page.locator(".msg").filter({ has: mark });
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await expect(mark.locator(".reaction-own")).toHaveText("✓");
  await expect(mark).not.toHaveAttribute("data-confirmed", "true");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("fixture-reaction")),
  );
  await expect(mark).toHaveAccessibleName("heart, 3 people");
  await expect(mark).not.toHaveAttribute("data-confirmed", "true");
  await mark.click();
  await expect(row.getByRole("status")).toHaveText("Reaction removed.");
  await expect(mark.locator(".reaction-own")).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.holdWrites = "yes";
  });
  await mark.click();
  await expect(mark).toBeDisabled();
  await expect(mark).not.toHaveAttribute("data-confirmed", "true");
  await expect(row.getByRole("status")).toBeEmpty();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.writePending),
    )
    .toBe("yes");
  await page.evaluate(() => {
    const mark = document.querySelector(".reaction");
    mark?.addEventListener(
      "animationstart",
      () => {
        document.documentElement.dataset.reactionAnimated = "yes";
      },
      { once: true },
    );
    document.dispatchEvent(new Event("finish-write"));
  });
  await expect(row.getByRole("status")).toHaveText("Reaction added.");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.reactionAnimated),
    )
    .toBe("yes");
  await expect(mark).toBeEnabled();
  await expect(mark).not.toHaveAttribute("data-confirmed", "true");
  expect(await mark.innerText()).not.toMatch(/\d/);
  expect(
    await page.evaluate(() => document.documentElement.dataset.writeRequests),
  ).toBe("2");
});

test("a refused reaction rolls back without success; reduced motion stays still", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/console.html");
  const mark = page.getByRole("button", { name: /^heart,/ });
  const row = page.locator(".msg").filter({ has: mark });
  await mark.click();
  // Wait for the accepted removal before refusing the next request. The
  // pressed state changes optimistically, before the fixture responds.
  await expect(row.getByRole("status")).toHaveText("Reaction removed.");
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => {
    document.documentElement.dataset.refuseWrites = "yes";
  });
  await mark.click();
  await expect(row.getByRole("alert")).toHaveText("This change was refused.");
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  await expect(row.getByRole("status")).toBeEmpty();
  await page.evaluate(() => {
    document.documentElement.dataset.refuseWrites = "no";
  });
  await mark.click();
  await expect(row.getByRole("status")).toHaveText("Reaction added.");
  expect(
    await mark
      .locator(".reaction-glyph")
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
});

test("style preview is private, resettable and only reports success after saving", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const picker = page.locator(".settings-section").filter({
    has: page.getByRole("heading", { name: "Make yourself at home" }),
  });
  await picker.getByRole("button", { name: "mint", exact: true }).click();
  await expect(picker.locator(".style-preview-name")).toHaveAttribute(
    "style",
    /--person-name: var\(--name-mint/,
  );
  await expect(
    page.locator(".roster .person-name").filter({ hasText: /^Matt$/ }),
  ).not.toHaveAttribute("style", /--person-name: var\(--name-mint/);
  expect(
    await page.evaluate(() => document.documentElement.dataset.writeRequests),
  ).toBeUndefined();
  await picker.getByRole("button", { name: "Reset changes" }).click();
  await expect(
    picker.getByRole("button", { name: "Save your look" }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "mint", exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.dataset.refuseWrites = "yes";
  });
  await picker.getByRole("button", { name: "Save your look" }).click();
  await expect(picker.getByRole("alert")).toHaveText(
    "This change was refused.",
  );
  await expect(picker.getByRole("status")).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.refuseWrites = "no";
  });
  await picker.getByRole("button", { name: "Save your look" }).click();
  await expect(picker.getByRole("status")).toContainText("Your look is saved.");
});

test("status preview shows the draft, with away replacing the status line, without publishing", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit status", exact: true }).click();
  const editor = page.locator(".status-editor");
  await editor
    .getByRole("textbox", { name: /^status / })
    .fill("Out looking for the moon.");
  await editor
    .getByRole("textbox", { name: "reading", exact: true })
    .fill("The Creative Act");
  await editor.locator("summary").click();
  await expect(editor.locator(".status-draft-card")).toContainText(
    "Out looking for the moon.",
  );
  await expect(editor.locator(".status-draft-card")).toContainText(
    "The Creative Act",
  );
  await editor
    .getByRole("textbox", { name: /^away message / })
    .fill("Back after a little walk.");
  await expect(editor.locator(".status-draft-card")).toContainText(
    "Back after a little walk.",
  );
  await expect(editor.locator(".status-draft-card")).not.toContainText(
    "Out looking for the moon.",
  );
  expect(
    await page.evaluate(() => document.documentElement.dataset.writeRequests),
  ).toBeUndefined();
});

for (const [width, scale] of [
  [1440, 100],
  [760, 100],
  [760, 200],
]) {
  test(`media keeps images whole, confirms accepted stars and fits at ${width}/${scale}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: width ?? 760, height: 900 });
    await page.addInitScript(
      (scale) => localStorage.setItem("linger.interface.scale", String(scale)),
      scale,
    );
    await page.goto("/tests/fixtures/console.html?delight");
    if (scale === 200)
      await page
        .getByRole("button", { name: "Navigation", exact: true })
        .click();
    await page.getByRole("button", { name: "Media", exact: true }).click();
    const tile = page.locator(".media-tile").first();
    await expect(tile).toBeVisible();
    await tile
      .locator("img")
      .evaluate((node) =>
        node instanceof HTMLImageElement
          ? node.decode()
          : Promise.reject(new Error("missing image")),
      );
    expect(
      await tile
        .locator("img")
        .evaluate((node) => getComputedStyle(node).objectFit),
    ).toBe("contain");
    const star = tile.locator(".media-star");
    await page.evaluate(() => {
      document.documentElement.dataset.holdWrites = "yes";
    });
    await star.click();
    await expect(star).toBeDisabled();
    await expect(tile.locator(".media-confirmation")).toBeEmpty();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.writePending),
      )
      .toBe("yes");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("finish-write")),
    );
    await expect(tile.getByRole("status")).toHaveText(
      "Kept. Starred files don’t expire.",
    );
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => {
      document.documentElement.dataset.holdWrites = "no";
      document.documentElement.dataset.refuseWrites = "yes";
    });
    await star.click();
    await expect(page.getByRole("alert")).toHaveText(
      "This change was refused.",
    );
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(tile.locator(".media-confirmation")).toBeEmpty();
    expect(
      await page
        .locator(".media")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });
}

test("switching settings categories returns to the heading at 200% scale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 480 });
  await page.addInitScript(() =>
    localStorage.setItem("linger.interface.scale", "200"),
  );
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const save = page.getByRole("button", {
    name: "Save your look",
    exact: true,
  });
  await save.scrollIntoViewIfNeeded();
  expect(
    await page.locator(".settings-body").evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(100);
  expect(
    await page
      .locator(".settings-body")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Sound & voice", exact: true })
    .click();
  expect(
    await page.locator(".settings-body").evaluate((node) => node.scrollTop),
  ).toBe(0);
  await expect(
    page.getByRole("heading", { name: "A familiar little sound" }),
  ).toBeVisible();
});

test("every chime renders offline, stays short and quiet, and ends in silence", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/sounds.html");
  const rendered = await page.evaluate(async () => {
    const path = "/tests/fixtures/chime-review.ts";
    const module: typeof import("../fixtures/chime-review") = await import(
      path
    );
    return (await module.renderChimeSamples()).map(
      ({ cue, samples, rate }) => ({
        cue,
        peak: Math.max(...samples.map(Math.abs)),
        beginning: samples.slice(0, 1000).every((sample) => sample === 0),
        end: samples.slice(rate * 0.6).every((sample) => sample === 0),
        discontinuity: Math.max(
          ...samples
            .slice(1)
            .map((sample, index) => Math.abs(sample - (samples[index] ?? 0))),
        ),
        fingerprint: samples.reduce(
          (sum, sample, index) => sum + sample * index,
          0,
        ),
      }),
    );
  });
  expect(rendered).toHaveLength(12);
  expect(new Set(rendered.map((cue) => cue.fingerprint)).size).toBe(12);
  for (const cue of rendered) {
    expect(cue.peak, cue.cue).toBeGreaterThan(0.01);
    expect(cue.peak, cue.cue).toBeLessThan(0.2);
    expect(cue.beginning && cue.end, cue.cue).toBe(true);
    expect(cue.discontinuity, cue.cue).toBeLessThan(0.02);
  }
});
