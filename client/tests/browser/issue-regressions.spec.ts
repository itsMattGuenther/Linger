import { expect, test, type Locator, type Page } from "@playwright/test";

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
    // The mark is #138's turned-over name, not #121's weight and underline.
    const talking = page.locator('[data-talking="true"] .voice-name');
    await expect(talking).toHaveCSS("background-image", /gradient/);
    await expect(talking).toHaveCSS("text-decoration-line", "none");
  });
}

/** The computed `rgb()` of a color token, for comparing against computed styles. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

for (const theme of ["dark", "light"]) {
  test(`a talking name turns over onto its own color, and only while talking, in ${theme} (#138)`, async ({ page, browserName }) => {
    await page.goto("/tests/fixtures/voice.html");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Join Voice", exact: true }).click();
    await page.evaluate(() => document.dispatchEvent(new Event("fixture-seats")));
    const talking = page.locator('.voice-seat[data-talking="true"] .voice-name');
    const quiet = page.locator('.voice-seat:not([data-talking]) .voice-name').first();
    await expect(talking).toHaveCount(1);
    // Letters in the app background, which is the pair the palette's contrast
    // test guarantees, on a block painted in the person's own color.
    const background = await tokenColor(page, "--surface-0");
    await expect(talking).toHaveCSS("-webkit-text-fill-color", background);
    await expect(talking).toHaveCSS("background-image", /gradient/);
    await expect(talking).toHaveCSS("background-clip", "border-box");
    // Same weight as a quiet name: talking changes the block, not the letters.
    await expect(talking).toHaveCSS("font-weight", await quiet.evaluate((name) => getComputedStyle(name).fontWeight));
    await expect(quiet).toHaveCSS("background-image", "none");

    // Normalized names: the block is the reader's text color.
    await page.evaluate(() => { document.documentElement.dataset.normalize = "true"; });
    await expect(talking).toHaveCSS("background-image", "none");
    await expect(talking).toHaveCSS("background-color", await tokenColor(page, "--text-primary"));
    await expect(talking).toHaveCSS("-webkit-text-fill-color", background);
    await page.evaluate(() => { delete document.documentElement.dataset.normalize; });

    // Forced colors strip author backgrounds; the mark must survive that.
    // Only Chromium can emulate it.
    if (browserName === "chromium") {
      await page.emulateMedia({ forcedColors: "active" });
      await expect(talking).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(talking).toHaveCSS("forced-color-adjust", "none");
    }
  });
}

/**
 * The first and last rows of `clip` that differ from its top-left pixel, read
 * from a real screenshot: where the glyphs actually are, not their line box.
 */
async function inkRows(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<[number, number]> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async ([png, height]) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const rows: number[] = [];
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const at = (y * image.width + x) * 4;
        if ([0, 1, 2].some((c) => Math.abs((data[at + c] ?? 0) - (data[c] ?? 0)) > 40)) { rows.push(y); break; }
      }
    }
    const scale = image.height / height;
    return [(rows[0] ?? 0) / scale, (rows[rows.length - 1] ?? 0) / scale] as [number, number];
  }, [png, clip.height] as const);
}

/**
 * Every box whose size or place a reader could notice around the voice bar:
 * the bar, each seat and name, the state line, and the first messages under it.
 */
function voiceLayout(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height] : null;
    };
    return [".voice-bar", ".voice-seat", ".voice-name", ".voice-seat-state", ".msg"].flatMap((selector) =>
      [...document.querySelectorAll(selector)].slice(0, 4).map((el) => [selector, box(el)]));
  });
}

/**
 * [`voiceLayout`] once it has stopped changing: the stream is still measuring
 * its rows just after load, so wait until two readings agree.
 */
async function settledVoiceLayout(page: Page) {
  let last = await voiceLayout(page);
  await expect.poll(async () => {
    const again = await voiceLayout(page);
    const settled = JSON.stringify(again) === JSON.stringify(last);
    last = again;
    return settled;
  }).toBe(true);
  return last;
}

for (const alone of [true, false]) {
  test(`voice names sit centered and talking moves nothing, ${alone ? "alone" : "with others"} (#137)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html");
    await page.getByRole("button", { name: "Join Voice", exact: true }).click();
    // Jules is in voice before you join, so wait for your own seat: that
    // arrives with the join's update, and "alone" has to land after it.
    await expect(page.getByRole("button", { name: "Matt, you, voice options", exact: true })).toBeVisible();
    if (alone) {
      await page.evaluate(() => document.dispatchEvent(new Event("fixture-voice-alone")));
      await expect(page.locator(".voice-seat")).toHaveCount(1);
    }
    const talk = (peer: string | null, talking: boolean) =>
      page.evaluate(([peer, talking]) =>
        document.dispatchEvent(new CustomEvent("fixture-talking", { detail: [peer, talking] })), [peer, talking] as const);
    const layout = () => voiceLayout(page);
    const quiet = await settledVoiceLayout(page);

    const seats = page.locator(".voice-seat");
    const centers = await seats.evaluateAll((nodes) => nodes.map((seat) => {
      const s = seat.getBoundingClientRect(), n = seat.querySelector(".voice-name")!.getBoundingClientRect();
      return Math.abs(s.x + s.width / 2 - (n.x + n.width / 2));
    }));
    for (const off of centers) expect(off).toBeLessThan(1);
    // The name's letters, inside its padding, line up with the heading's.
    const letters = await page.locator(".voice-name").first().evaluate((name) =>
      name.getBoundingClientRect().x + parseFloat(getComputedStyle(name).paddingLeft));
    const heading = await page.locator(".voice-label").boundingBox();
    expect(Math.abs(letters - (heading?.x ?? 0))).toBeLessThan(1);
    const first = await page.locator(".voice-name").first().boundingBox();
    if (alone && first && heading) {
      // Vertically: the name's letters sit halfway between the heading's
      // letters and the bar's bottom edge, measured in pixels.
      const bar = (await page.locator(".voice-bar").boundingBox())!;
      const label = await inkRows(page, heading);
      const name = await inkRows(page, first);
      const above = first.y + name[0] - (heading.y + label[1]);
      const below = bar.y + bar.height - 1 - (first.y + name[1]);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(3);
    }

    await talk(null, true);
    if (!alone) await talk("jules-voice", true);
    await expect(page.locator('.voice-seat[data-talking="true"]')).toHaveCount(alone ? 1 : 2);
    await expect(page.locator('[data-talking="true"] .voice-name').first()).toHaveCSS("background-image", /gradient/);
    expect(await layout()).toEqual(quiet);

    await talk(null, false);
    if (!alone) await talk("jules-voice", false);
    await expect(page.locator('.voice-seat[data-talking="true"]')).toHaveCount(0);
    expect(await layout()).toEqual(quiet);
  });
}

for (const alone of [true, false]) {
  test(`muting shows a glyph beside the name and moves nothing, ${alone ? "alone" : "with others"} (#138)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html");
    await page.getByRole("button", { name: "Join Voice", exact: true }).click();
    await expect(page.getByRole("button", { name: "Matt, you, voice options", exact: true })).toBeVisible();
    if (alone) {
      await page.evaluate(() => document.dispatchEvent(new Event("fixture-voice-alone")));
      await expect(page.locator(".voice-seat")).toHaveCount(1);
    }
    const mine = page.locator(".voice-seat").first();
    await expect(mine.locator(".voice-state-icon")).toHaveCount(0);
    const before = await settledVoiceLayout(page);

    await page.getByRole("button", { name: "Mute", exact: true }).click();
    const icon = mine.locator(".voice-state-icon");
    await expect(icon).toHaveAttribute("title", "Muted");
    expect(await voiceLayout(page)).toEqual(before);

    // The glyph reads as this name's: right of its letters, nearer them than
    // the next name, and inside the bar.
    const shape = await mine.evaluate((seat) => {
      const name = seat.querySelector(".voice-name")!, glyph = seat.querySelector(".voice-state-icon")!;
      const n = name.getBoundingClientRect(), g = glyph.getBoundingClientRect();
      const letters = n.right - parseFloat(getComputedStyle(name).paddingRight);
      const next = seat.nextElementSibling?.querySelector(".voice-name");
      const nextLetters = next ? next.getBoundingClientRect().x + parseFloat(getComputedStyle(next).paddingLeft) : null;
      const bar = seat.closest(".voice-bar")!.getBoundingClientRect();
      return { own: g.x - letters, next: nextLetters === null ? null : nextLetters - g.right, right: g.right, barRight: bar.right,
        middle: Math.abs(g.y + g.height / 2 - (n.y + n.height / 2)) };
    });
    expect(shape.own).toBeGreaterThan(0);
    if (shape.next !== null) expect(shape.next).toBeGreaterThan(shape.own * 2);
    expect(shape.right).toBeLessThanOrEqual(shape.barRight);
    expect(shape.middle).toBeLessThan(1);

    await page.getByRole("button", { name: "Muted", exact: true }).click();
    await expect(icon).toHaveCount(0);
    expect(await voiceLayout(page)).toEqual(before);
  });
}

/**
 * Start recording what every painted frame looked like: sampled in a task
 * queued from requestAnimationFrame, which runs after that frame's layout,
 * observers and paint. Read the frames back with [`paintedFrames`].
 */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { painted: Record<string, unknown>[]; recording: boolean };
    store.painted = [];
    store.recording = true;
    const sample = () => {
      const bar = document.querySelector(".voice-bar")!.getBoundingClientRect();
      const stream = document.querySelector(".stream-body")!;
      const top = [...stream.querySelectorAll<HTMLElement>(".msg")].find((row) =>
        row.getBoundingClientRect().top >= stream.getBoundingClientRect().top);
      store.painted.push({
        bar: Math.round(bar.height),
        fromBottom: Math.round(stream.scrollHeight - stream.scrollTop - stream.clientHeight),
        seats: document.querySelectorAll(".voice-seat").length,
        line: document.querySelector(".voice-bar .voice-line")?.textContent ?? null,
        seated: document.querySelector(".voice-label")?.textContent === "In voice",
        top: top?.textContent?.slice(0, 40) ?? null,
      });
      if (store.recording) requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(() => setTimeout(sample, 0));
  });
}

async function paintedFrames(page: Page) {
  return page.evaluate(() => {
    const store = window as unknown as {
      painted: { bar: number; fromBottom: number; seats: number; line: string | null; seated: boolean; top: string | null }[];
      recording: boolean;
    };
    store.recording = false;
    return store.painted;
  });
}

test("joining and leaving voice change the bar once each and never lift the conversation (#141, #142)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?slowjoin");
  await expect(page.locator(".msg").first()).toBeVisible();
  await settledVoiceLayout(page);
  const before = (await page.locator(".voice-bar").boundingBox())!.height;
  await recordFrames(page);
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  // The fixture lists you at 250 ms and opens the microphone at 500 ms.
  await expect(page.locator(".voice-bar .voice-line")).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole("button", { name: "Leave voice", exact: true })).toBeVisible();
  const during = (await page.locator(".voice-bar").boundingBox())!.height;
  await page.getByRole("button", { name: "Leave voice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Join Voice", exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  const frames = await paintedFrames(page);

  expect(frames.some((frame) => frame.line === "opening the microphone…")).toBe(true);
  // Every painted frame is one of two bars: before joining, or in voice.
  expect([...new Set(frames.map((frame) => frame.bar))].sort()).toEqual([before, during].map(Math.round).sort());
  const steps = frames.filter((frame, i) => i > 0 && frame.bar !== frames[i - 1]!.bar);
  expect(steps).toHaveLength(2);
  for (const frame of frames) {
    // In voice means your seat is drawn; out of voice means it is not.
    expect(frame.seats).toBe(frame.seated ? 1 : 0);
    // The conversation stays on its newest message in every painted frame.
    expect(frame.fromBottom).toBeLessThanOrEqual(2);
  }
});

test("joining voice keeps your place when you have scrolled up (#142)", async ({ page }) => {
  await page.goto("/tests/fixtures/console.html?slowjoin&history");
  const stream = page.locator(".stream-body");
  await expect(page.locator(".msg").first()).toBeVisible();
  await settledVoiceLayout(page);
  await stream.hover();
  await page.mouse.wheel(0, -1200);
  await expect.poll(() => stream.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(400);
  await settledVoiceLayout(page);
  await recordFrames(page);
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  await expect(page.locator(".voice-bar .voice-line")).toHaveCount(0, { timeout: 5000 });
  const frames = await paintedFrames(page);
  // The same message is at the top of the view in every frame.
  expect(new Set(frames.map((frame) => frame.top)).size).toBe(1);
  expect(frames[0]!.fromBottom).toBeGreaterThan(100);
});

/**
 * Hover `button` and require its name as one whole tooltip: inside the window,
 * on top of everything at its middle and corners, and the button drawing no
 * second, clippable copy of its own.
 */
async function expectWholeTooltip(page: Page, button: Locator, name: string): Promise<void> {
  await button.hover();
  const tip = page.getByRole("tooltip").filter({ hasText: name });
  await expect(tip).toBeVisible();
  const whole = await tip.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const inset = 2;
    const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset], [r.left + inset, r.bottom - inset], [r.right - inset, r.bottom - inset]];
    // Tooltips ignore the pointer, which also hides them from
    // elementFromPoint; let it see this one just for the check.
    const tooltip = node as HTMLElement;
    tooltip.style.pointerEvents = "auto";
    const onTop = points.every(([x, y]) => node.contains(document.elementFromPoint(x!, y!)));
    tooltip.style.pointerEvents = "";
    return {
      inWindow: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      onTop,
    };
  });
  expect(whole).toEqual({ inWindow: true, onTop: true });
  expect(await button.evaluate((node) => getComputedStyle(node, "::after").content)).toBe("none");
  await page.mouse.move(1, 1);
  await expect(tip).toHaveCount(0);
}

const VOICE_TIPS = ["Mute", "Deafen", "Leave voice"];

for (const [label, height, collapse] of [["expanded", 800, false], ["collapsed", 800, true], ["collapsed in a short window", 340, true]] as const) {
  test(`voice control tooltips show whole, ${label} (#140)`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height });
    await page.goto("/tests/fixtures/console.html");
    await page.getByRole("button", { name: "Join Voice", exact: true }).click();
    await expect(page.getByRole("button", { name: "Leave voice", exact: true })).toBeVisible();
    const toggle = page.getByRole("button", { name: collapse ? "Collapse voice participants" : "Expand voice participants" });
    if (await toggle.count()) await toggle.click();
    if (collapse) await expect(page.locator(".voice-bar")).toHaveAttribute("data-collapsed", "true");
    else await expect(page.locator(".voice-bar")).not.toHaveAttribute("data-collapsed");
    for (const name of VOICE_TIPS) {
      await expectWholeTooltip(page, page.getByRole("button", { name, exact: true }), name);
    }
    await expectWholeTooltip(page, page.locator(".voice-collapse"),
      collapse ? "Expand voice participants" : "Collapse voice participants");
  });
}

test("voice control tooltips show whole under the push-to-talk line and in the ongoing strip (#140)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Join Voice", exact: true }).click();
  // Push-to-talk puts "hold ctrl to talk" in the bar. Before #141 that moved
  // the controls to its bottom edge, where a tooltip drawn below them was cut
  // off; the line now sits by the heading, and the tooltips must stay whole.
  await expect(page.locator(".voice-bar .voice-line")).toBeVisible();
  for (const name of ["Deafen", "Leave voice"]) {
    await expectWholeTooltip(page, page.locator(".voice-bar").getByRole("button", { name, exact: true }), name);
  }
  // The ongoing strip sits on the window's bottom edge.
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const ongoing = page.getByRole("region", { name: "Ongoing voice" });
  await expect(ongoing).toBeVisible();
  for (const name of ["Deafen", "Leave voice"]) {
    await expectWholeTooltip(page, ongoing.getByRole("button", { name, exact: true }), name);
  }
});

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

test("hovering a message shows its actions button and changes nothing else (#139)", async ({ page }) => {
  // Motion stays on: the fade this guards against is off under reduced motion.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/tests/fixtures/console.html?qa&replies&delight&hovering");
  const messages = page.locator(".msg");
  await expect(messages.last()).toContainText("trail map");
  // One of each kind the issue names, so a new hover rule on any of them fails here.
  await expect(page.locator(".msg-reply").first()).toBeVisible();
  await expect(page.locator(".reaction").first()).toBeVisible();
  await expect(page.locator(".msg-edited").first()).toBeVisible();
  await expect(page.locator(".msg .md-link").first()).toBeVisible();
  await expect(page.locator(".msg .card").first()).toBeVisible();
  await expect(page.locator(".msg .att-image").first()).toBeVisible();
  await expect(page.locator(".msg .att-get").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  // Every box and every computed style in the message, the actions button aside.
  const snapshot = (message: Locator) =>
    message.evaluate((node) =>
      [node, ...node.querySelectorAll("*")]
        .filter((element) => !element.closest(".msg-actions-trigger"))
        .map((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const properties: Record<string, string> = {
            box: `${box.top},${box.left},${box.width},${box.height}`,
          };
          for (const property of Array.from(style)) properties[property] = style.getPropertyValue(property);
          return { name: `${element.tagName.toLowerCase()}.${element.className}`, properties };
        }),
    );
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const changes = (before: Snapshot, after: Snapshot): string[] =>
    before.flatMap(({ name, properties }, index) =>
      Object.entries(properties)
        .filter(([property, value]) => after[index]?.properties[property] !== value)
        .map(([property, value]) => `${name} ${property}: ${value} -> ${after[index]?.properties[property]}`),
    );

  const count = await messages.count();
  for (let index = 0; index < count; index++) {
    const message = messages.nth(index);
    await page.mouse.move(1099, 1);
    await message.scrollIntoViewIfNeeded();
    const before = await snapshot(message);
    const trigger = message.locator(".msg-actions-trigger");
    // Hover each part of the message, not just its edge: a link, a reply line,
    // a reaction and a name each had a hover style of their own.
    const parts = message.locator(".msg-body, .msg-reply, .reaction, .md-link, .msg-author, .card, .att-image, .att-get");
    for (let part = 0; part < await parts.count(); part++) {
      await parts.nth(part).hover();
      // Shown in the same frame, not faded in. An opacity fade puts the button
      // on its own compositing layer, and WebKitGTK redraws the message around it.
      expect(await trigger.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
      expect(changes(before, await snapshot(message))).toEqual([]);
    }
  }
});
