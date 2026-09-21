import { expect, test } from "@playwright/test";

test("one server identity, simple DMs, personal settings and deliberate host tools", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await expect(page.getByText("The Good Company", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("heading", { name: "DMs", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rail-dms")).toContainText("empty");
  await page.locator(".roster").getByRole("button", { name: /Jules/ }).click();
  await expect(
    page.getByRole("button", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "remove from the server", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Server options", exact: true }).click();
  await page.getByRole("button", { name: "Server settings", exact: true }).click();
  await page.getByRole("button", { name: "people", exact: true }).click();
  const jules = page.locator(".host-member").filter({ hasText: "Jules" });
  await jules
    .getByRole("button", { name: "remove from the server", exact: true })
    .click();
  await expect(jules).toContainText("Remove Jules from this server?");
  await jules.getByRole("button", { name: "keep them", exact: true }).click();
  await expect(
    jules.getByRole("button", { name: "yes, remove", exact: true }),
  ).toHaveCount(0);
});

test("members have the same ordinary card without a host tools entry", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html?member");
  await page.locator(".roster").getByRole("button", { name: /Jules/ }).click();
  await expect(
    page.getByRole("button", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Server options", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /remove from/ })).toHaveCount(
    0,
  );
});

test("panel boundaries support pointer, keyboard, reset and persistence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/console.html");
  const rail = page.getByRole("separator", { name: "Resize navigation" });
  await rail.focus();
  await page.keyboard.press("ArrowRight");
  await expect(rail).toHaveAttribute("aria-valuenow", "240");
  const roster = page.getByRole("separator", { name: "Resize people panel" });
  const box = await roster.boundingBox();
  if (!box) throw new Error("missing separator");
  await page.mouse.move(box.x + 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 38, box.y + 100);
  await page.mouse.up();
  await expect(roster).toHaveAttribute("aria-valuenow", "304");
  // Persistence runs in an effect after the visible resize. Wait for that
  // write before reloading; the ARIA value alone does not prove it finished.
  await expect.poll(() => page.evaluate(() => ({
    rail: localStorage.getItem("linger.interface.rail"),
    roster: localStorage.getItem("linger.interface.roster"),
  }))).toEqual({ rail: "240", roster: "304" });
  await page.reload();
  await expect(rail).toHaveAttribute("aria-valuenow", "240");
  await expect(roster).toHaveAttribute("aria-valuenow", "304");
  await roster.dblclick();
  await expect(roster).toHaveAttribute("aria-valuenow", "264");
  await rail.focus();
  await page.keyboard.press("Home");
  await expect(rail).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("End");
  await expect(rail).toHaveAttribute("aria-valuenow", "360");
});

test("settings is keyboard reachable, closes with Escape and restores focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Profile", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".room-item[aria-current='true']")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect(page.getByRole("textbox", { name: /message/i })).toHaveCount(1);
});

test("voice volume is on demand and hiding people keeps call controls", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await page
    .getByRole("button", { name: "Jules, voice options", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("slider", { name: /Volume for Jules/ }),
  ).toBeVisible();
  await page.getByRole("slider").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("slider")).toHaveValue("0.95");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Jules, voice options" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Collapse voice participants" }).click();
  await expect(
    page.getByRole("button", { name: "Deafen", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Leave voice", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand voice participants" })).toBeVisible();
});

async function openSettings(page: import("@playwright/test").Page) {
  const navigation = page.getByRole("button", {
    name: "Navigation",
    exact: true,
  });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

test("ongoing voice stays controllable outside its room and returns without rejoining", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await openSettings(page);
  const ongoing = page.getByRole("region", { name: "Ongoing voice" });
  await expect(ongoing).toBeVisible();
  await ongoing.getByRole("button", { name: "Mute", exact: true }).click();
  await ongoing.getByRole("button", { name: "Deafen", exact: true }).click();
  await expect(
    ongoing.getByRole("button", { name: "Muted", exact: true }),
  ).toBeDisabled();
  await ongoing.getByRole("button", { name: "Undeafen", exact: true }).click();
  await expect(
    ongoing.getByRole("button", { name: "Muted", exact: true }),
  ).toBeEnabled();
  await ongoing
    .getByRole("button", { name: "Return to #general", exact: true })
    .click();
  await expect(ongoing).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Muted", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "#weekend-plans", exact: true })
    .click();
  await expect(ongoing).toBeVisible();
  await page.getByRole("button", { name: "Media", exact: true }).click();
  await expect(ongoing).toBeVisible();
  await ongoing
    .getByRole("button", { name: "Leave voice", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-left", "yes");
  await expect(ongoing).toHaveCount(0);
});

test("push-to-talk releases on navigation and works in Settings without duplicate listeners", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("linger.voice.pushToTalk", "true"),
  );
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await page.keyboard.down("Control");
  await expect(page.locator("html")).toHaveAttribute(
    "data-controls",
    '{"muted":false,"deafened":false}',
  );
  await openSettings(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-controls",
    '{"muted":true,"deafened":false}',
  );
  await page.keyboard.up("Control");
  await page.keyboard.down("Control");
  await expect(page.locator("html")).toHaveAttribute(
    "data-controls",
    '{"muted":false,"deafened":false}',
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("html")).toHaveAttribute(
    "data-controls",
    '{"muted":true,"deafened":false}',
  );
  await page.keyboard.up("Control");
});

test("an away-view control failure remains visible after voice disconnects", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await openSettings(page);
  await page.evaluate(() => {
    document.documentElement.dataset.refuse = "yes";
  });
  await page.getByRole("button", { name: "Deafen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Couldn't change voice controls",
  );
  await expect(page.locator("html")).toHaveAttribute("data-left", "yes");
});

test("voice and Appearance controls fit a short window at 200%", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 480 });
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await openSettings(page);
  await page
    .getByRole("combobox", { name: "Scale", exact: true })
    .selectOption("200");
  await expect(
    page.getByRole("combobox", { name: "Scale", exact: true }),
  ).toBeInViewport();
  for (const label of ["Mute", "Deafen", "Leave voice"]) {
    const control = page.getByRole("button", { name: label, exact: true });
    await expect(control).toBeInViewport();
    const box = await control.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(480);
  }
  await page.getByRole("button", { name: "Leave voice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Ongoing voice" })).toHaveCount(
    0,
  );
});

test("plain styling has a clear label and long messages have a readable line length", async ({
  page,
}) => {
  await page.setViewportSize({ width: 3072, height: 1728 });
  await page.goto("/tests/fixtures/console.html?history");
  await expect(page.locator(".msg-body").last()).toBeVisible();
  expect(
    await page
      .locator(".msg-body")
      .last()
      .evaluate((node) => node.getBoundingClientRect().width),
  ).toBeLessThan(1000);
  await openSettings(page);
  const plain = page.getByRole("switch", {
    name: "Use plain names and message fonts",
    exact: true,
  });
  expect(await page.locator('.preference-copy label').last().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  await plain.click();
  await expect(plain).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-normalize", "true");
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [1100, 760]) {
    test(`${theme}, ${width}px: readable layout and large text fit without tuning`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const height = width === 760 ? 480 : 720;
      await page.setViewportSize({ width, height });
      await page.goto("/tests/fixtures/console.html");
      for (const scale of ["100", "110", "125", "150", "175", "200"]) {
        await openSettings(page);
        await expect(
          page.getByRole("heading", { name: "density", exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole("combobox", { name: "Scale", exact: true })
          .selectOption(scale);
        await expect(
          page.getByRole("combobox", { name: "Scale", exact: true }),
        ).toBeInViewport();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.locator(".composer-input")).toBeInViewport();
        const statusTop = await page
          .locator(".status-bar")
          .evaluate((node) => node.getBoundingClientRect().top);
        expect(
          await page
            .locator(".composer-input")
            .evaluate((node) => node.getBoundingClientRect().bottom),
        ).toBeLessThanOrEqual(statusTop);
        expect(
          await page
            .locator(".composer-send")
            .evaluate((node) => node.getBoundingClientRect().bottom),
        ).toBeLessThanOrEqual(statusTop);
        expect(
          await page
            .locator(".composer-input")
            .evaluate((node) => node.getBoundingClientRect().bottom),
        ).toBeLessThanOrEqual(height);
        expect(
          await page.getByRole("log").evaluate((node) => node.clientHeight),
        ).toBeGreaterThan(32);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.reload();
      expect(
        await page
          .locator("html")
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe("32px");
      await openSettings(page);
      await page
        .getByRole("combobox", { name: "Scale", exact: true })
        .selectOption("100");
      expect(
        await page
          .locator("html")
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe("16px");
    });
  }
}

for (const oldMode of ["compact", "irc"]) {
  test(`old ${oldMode} preference cannot restore a removed mode`, async ({
    page,
  }) => {
    await page.addInitScript(
      (mode) => localStorage.setItem("linger.density", mode),
      oldMode,
    );
    await page.goto("/tests/fixtures/console.html");
    await expect(page.locator(".msg-body").first()).toBeVisible();
    expect(
      await page
        .locator(".msg-body")
        .first()
        .evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe("16px");
    await expect(page.locator(".irc-name")).toHaveCount(0);
    await openSettings(page);
    await expect(
      page.getByRole("button", { name: /^(compact|irc|comfortable)$/i }),
    ).toHaveCount(0);
  });
}

test("narrow panels are reachable by keyboard and return to columns when resized", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 480 });
  await page.goto("/tests/fixtures/console.html");
  const people = page.getByRole("button", { name: "People", exact: true });
  await people.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close people" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(people).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 820 });
  await expect(
    page.getByRole("complementary", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(people).toHaveCount(0);
  await expect(
    page.getByRole("separator", { name: "Resize people panel" }),
  ).toBeVisible();
});

test("enabled labels meet normal-text contrast in both themes, including evening warmth", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  // Measure settled colors, not a frame partway through a theme transition.
  await page.addStyleTag({ content: "* { transition: none !important; }" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  for (const theme of ["dark", "light"])
    for (const warmth of ["cool", "warm"]) {
      const failures = await page.evaluate(
        ({ theme, warmth }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.warmth = warmth;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Missing contrast canvas");
          const luminance = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            return channels
              .map((value) => {
                const n = value / 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              })
              .reduce(
                (sum, value, index) =>
                  sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0),
                0,
              );
          };
          return [
            ...document.querySelectorAll<HTMLElement>(
              ".panel-label, .rail-action, .room-item, .roster-switch, .settings-tab, .theme-card-label, .preference-copy label, .preference-copy p, .settings-lead, .settings-hint",
            ),
          ]
            .filter(
              (node) =>
                node.getClientRects().length && !node.matches(":disabled"),
            )
            .map((node) => {
              const style = getComputedStyle(node);
              let parent: HTMLElement | null = node;
              let background = "rgb(255, 255, 255)";
              while (parent) {
                const candidate = getComputedStyle(parent).backgroundColor;
                if (
                  candidate !== "rgba(0, 0, 0, 0)" &&
                  candidate !== "transparent"
                ) {
                  background = candidate;
                  break;
                }
                parent = parent.parentElement;
              }
              const a = luminance(style.color),
                b = luminance(background);
              return {
                text: node.textContent,
                foreground: style.color,
                background,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              };
            })
            .filter(({ contrast }) => contrast < 4.5);
        },
        { theme, warmth },
      );
      expect(failures, `${theme}/${warmth}`).toEqual([]);
    }
});

test("an unsaved status survives moving the people panel between layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/tests/fixtures/console.html");
  await page.locator(".roster").getByRole("button", { name: /Matt/ }).click();
  await page
    .locator(".roster")
    .getByRole("button", { name: "Edit status", exact: true })
    .click();
  const draft = page.locator(".roster textarea").first();
  await draft.fill("A status I have not saved yet.");
  await page.setViewportSize({ width: 760, height: 480 });
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(draft).toHaveValue("A status I have not saved yet.");
  await page.setViewportSize({ width: 1280, height: 820 });
  await expect(draft).toHaveValue("A status I have not saved yet.");
  await expect(draft).toBeVisible();
});

for (const timing of ["during landing", "after landing"]) {
  test(`long history stays virtualized when resizing ${timing}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/tests/fixtures/console.html?history");
    await expect(page.getByText(/^History sample 9999\./)).toBeVisible();
    if (timing === "after landing") {
      await expect(page.getByText(/^History sample 9999\./)).toBeInViewport();
      // Exercise a settled room separately from immediate first-load resizing.
      await page.waitForTimeout(300);
    }
    expect(await page.locator(".stream-row").count()).toBeLessThan(80);
    await page.getByRole("separator", { name: "Resize navigation" }).focus();
    await page.keyboard.press("End");
    await page.getByRole("separator", { name: "Resize people panel" }).focus();
    await page.keyboard.press("End");
    await expect(page.getByText(/^History sample 9999\./)).toBeInViewport();
    const log = page.getByRole("log");
    await log.evaluate((node) => {
      node.scrollTop -= 1000;
    });
    await page.waitForTimeout(200);
    const overlap = () =>
      page.locator(".stream-row").evaluateAll((nodes) => {
        const rects = nodes
          .map((node) => node.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        return rects.some(
          (rect, index) =>
            index > 0 && rect.top < (rects[index - 1]?.bottom ?? 0) - 1,
        );
      });
    await expect.poll(overlap).toBe(false);
    expect(await page.locator(".stream-row").count()).toBeLessThan(80);
  });
}

test("resizing while reading older messages does not jump to the newest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/console.html?history");
  await expect(page.getByText(/^History sample 9999\./)).toBeInViewport();
  await page.waitForTimeout(300);
  const log = page.getByRole("log");
  await log.evaluate((node) => {
    // Stay within the loaded page: this check isolates resizing from paging.
    node.scrollTop -= 900;
  });
  await expect(page.getByText(/^History sample 9999\./)).toHaveCount(0);
  const reading = await page.locator(".stream-row").evaluateAll((nodes) => {
    const top = document
      .querySelector(".stream-body")!
      .getBoundingClientRect().top;
    return nodes
      .find((node) => node.getBoundingClientRect().top >= top)
      ?.getAttribute("data-index");
  });
  expect(reading).toBeTruthy();
  await page.getByRole("separator", { name: "Resize navigation" }).focus();
  await page.keyboard.press("End");
  await page.getByRole("separator", { name: "Resize people panel" }).focus();
  await page.keyboard.press("End");
  await expect(
    page.locator(`.stream-row[data-index="${reading}"]`),
  ).toBeInViewport();
  await expect(page.getByText(/^History sample 9999\./)).toHaveCount(0);
});

test("interface size belongs in Settings and saved scale also applies to sign-in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 480 });
  await page.goto("/");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page).toHaveTitle("Linger");
  await expect(
    page.getByRole("heading", { name: "Linger", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Paste an invite to join/),
  ).toBeVisible();
  await page.goto("/tests/fixtures/console.html");
  await openSettings(page);
  await page
    .getByRole("combobox", { name: "Scale", exact: true })
    .selectOption("200");
  await page.goto("/");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("html")).toHaveCSS("font-size", "32px");
  await page
    .getByRole("textbox", { name: "server or link" })
    .fill("https://example.com");
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("font-size", "32px");
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

for (const display of [
  {
    name: "4K at desktop 100%",
    width: 3840,
    height: 2160,
    deviceScaleFactor: 1,
  },
  {
    name: "4K at desktop 125%",
    width: 3072,
    height: 1728,
    deviceScaleFactor: 1.25,
  },
  {
    name: "4K at desktop 200%",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 2,
  },
]) {
  for (const scale of [100, 150, 200]) {
    test(`${display.name}, app ${scale}%: readable text, controls and panels fit`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: display.width, height: display.height },
        deviceScaleFactor: display.deviceScaleFactor,
      });
      try {
        await context.addInitScript(
          (value) =>
            localStorage.setItem("linger.interface.scale", String(value)),
          scale,
        );
        const page = await context.newPage();
        await page.goto("/tests/fixtures/console.html");
        await expect(page.locator(".msg-body").first()).toBeVisible();
        expect(
          await page
            .locator(".msg-body")
            .first()
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toBe(`${(16 * scale) / 100}px`);
        const controls = page.getByRole("button", {
          name: "Settings",
          exact: true,
        });
        expect(
          await controls.evaluate(
            (node) => node.getBoundingClientRect().height,
          ),
        ).toBeGreaterThanOrEqual((24 * scale) / 100);
        await expect(
          page.getByRole("separator", { name: "Resize people panel" }),
        ).toBeVisible();
        await expect(page.locator(".composer-input")).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.reload();
        expect(
          await page
            .locator("html")
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toBe(`${(16 * scale) / 100}px`);
      } finally {
        await context.close();
      }
    });
  }
}

// Shared across every #83 regression below. Design intent: the rail never
// grows a horizontal scrollbar, at any width — long, unbreakable text wraps
// or truncates in place instead. Only the vertical scrollbar is meant to come
// and go, and only with the window's height.
async function railHasNoSidewaysOverflow(
  page: import("@playwright/test").Page,
) {
  expect(
    await page
      .locator(".rail-content")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
}

// The scrollWidth/clientWidth check above catches the scroll box itself
// growing sideways, but not a single row quietly poking past the box's own
// right edge while the box "absorbs" it some other way. This walks every
// text-bearing row (the server name, every room, every DM, Media and
// Search) and fails if any of them render past where the scroll box's own
// content ends — which is what stops someone from "fixing" #83 later by
// slapping overflow-x: hidden on the box instead of closing the gap it
// overflows.
async function railTextNeverEscapesTheScrollBox(
  page: import("@playwright/test").Page,
) {
  const overflowing = await page.locator(".rail-content").evaluate((node) => {
    const innerRight = node.getBoundingClientRect().left + node.clientWidth;
    return [
      ...node.querySelectorAll(".server-name, .room-item, .room-slug"),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.getBoundingClientRect().right - innerRight)
      .filter((overshootPx) => overshootPx > 1);
  });
  expect(overflowing).toEqual([]);
}

test("the rail's scroll box never grows a sideways scrollbar (#83)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/console.html");
  const rail = page.locator(".rail");
  const places = page.locator(".rail-places");

  // The hairline above Media/Search bleeds out to the rail's own edges by
  // design (it is drawn full-bleed, like every other hairline). Checking it
  // still reaches those edges catches a future "fix" that clips it short
  // with overflow-x: hidden instead of closing the gap it overflows.
  const hairlineSpansRail = async () => {
    const railBox = await rail.boundingBox();
    const placesBox = await places.boundingBox();
    if (!railBox || !placesBox) throw new Error("missing rail or places box");
    expect(Math.abs(placesBox.x - railBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(placesBox.x + placesBox.width - (railBox.x + railBox.width)),
    ).toBeLessThanOrEqual(1);
  };

  // (a) At the default width, the rail's content is nowhere near tall enough
  // to need vertical scrolling, so there is nothing to check but that the box
  // is exactly as wide as its own content.
  await railHasNoSidewaysOverflow(page);
  await hairlineSpansRail();

  // (b) Resizing the rail narrower and then wider must not reopen the gap:
  // the scroll box is full-bleed to whatever width the rail currently has.
  const railSeparator = page.getByRole("separator", {
    name: "Resize navigation",
  });
  await railSeparator.focus();
  await page.keyboard.press("Home");
  await expect(railSeparator).toHaveAttribute("aria-valuenow", "200");
  await railHasNoSidewaysOverflow(page);
  await hairlineSpansRail();
  await page.keyboard.press("End");
  await expect(railSeparator).toHaveAttribute("aria-valuenow", "360");
  await railHasNoSidewaysOverflow(page);
  await hairlineSpansRail();

  // (c) A short window is where the rail genuinely needs to scroll up and
  // down. That must not also turn on sideways scrolling.
  await page.setViewportSize({ width: 900, height: 480 });
  await expect
    .poll(() =>
      page
        .locator(".rail-content")
        .evaluate((node) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  await railHasNoSidewaysOverflow(page);

  // (d) Narrow enough that navigation moves into a drawer over the message
  // list: same scroll box, same fix.
  await page.setViewportSize({ width: 600, height: 480 });
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Navigation", exact: true }),
  ).toBeVisible();
  await railHasNoSidewaysOverflow(page);
});

async function dragRailSeparatorSweep(
  page: import("@playwright/test").Page,
  fixtureUrl: string,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixtureUrl);
  const separator = page.getByRole("separator", {
    name: "Resize navigation",
  });
  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "200");
  const box = await separator.boundingBox();
  if (!box) throw new Error("missing separator");
  const y = box.y + box.height / 2;
  const startX = box.x + 2;

  // A real pointer drag, not the keyboard: down at the minimum width, then a
  // sampled walk out to the maximum and all the way back, checking at every
  // sampled width along the way rather than just at the two ends.
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const sampledWidths: number[] = [];
  const sample = async (dx: number) => {
    await page.mouse.move(startX + dx, y, { steps: 4 });
    sampledWidths.push(Number(await separator.getAttribute("aria-valuenow")));
    await railHasNoSidewaysOverflow(page);
    await railTextNeverEscapesTheScrollBox(page);
  };
  for (let dx = 0; dx <= 160; dx += 20) await sample(dx);
  for (let dx = 160; dx >= 0; dx -= 20) await sample(dx);
  await page.mouse.up();

  // Confirm the drag actually reached both ends, so this sweep exercised the
  // full range rather than stalling short of it.
  expect(Math.min(...sampledWidths)).toBe(200);
  expect(Math.max(...sampledWidths)).toBe(360);
}

for (const [label, fixtureUrl] of [
  ["", "/tests/fixtures/console.html"],
  [
    " with a name too long to fit wrapping the whole way through",
    "/tests/fixtures/console.html?longnames",
  ],
] as const) {
  test(`dragging the rail separator by hand, the whole way and back, never opens a sideways scrollbar${label} (#83)`, async ({
    page,
  }) => {
    await dragRailSeparatorSweep(page, fixtureUrl);
  });
}

async function railWindowGridStep(
  page: import("@playwright/test").Page,
  width: number,
  rail: 200 | 360,
  fixtureUrl: string,
  // With a genuinely very long name wrapping in the narrowest rail, the
  // wrapped block alone can be taller than every height in the sweep below,
  // so the rail can be stuck scrolling vertically the whole time — that is
  // correct (there is more content than room), not a bug, so only the plain
  // grid requires the sweep to have exercised both states.
  requireBothVerticalStates: boolean,
) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(fixtureUrl);
  const separator = page.getByRole("separator", {
    name: "Resize navigation",
  });
  await separator.focus();
  await page.keyboard.press(rail === 200 ? "Home" : "End");
  await expect(separator).toHaveAttribute("aria-valuenow", String(rail));

  let sawVerticalScrolling = false;
  let sawNoVerticalScrolling = false;
  // Tall, then progressively shorter, then tall again: the vertical
  // scrollbar should switch on once the content stops fitting and switch
  // back off once it fits again, in either direction, not get stuck.
  // Nothing here hardcodes which heights scroll — that is measured, not
  // assumed.
  for (const height of [900, 720, 560, 480, 720, 900]) {
    await page.setViewportSize({ width, height });
    await railHasNoSidewaysOverflow(page);
    await railTextNeverEscapesTheScrollBox(page);
    const scrolls = await page
      .locator(".rail-content")
      .evaluate((node) => node.scrollHeight > node.clientHeight);
    if (scrolls) sawVerticalScrolling = true;
    else sawNoVerticalScrolling = true;
  }
  expect(sawVerticalScrolling).toBe(true);
  if (requireBothVerticalStates)
    // The sweep is pointless if it never actually exercised both states.
    expect(sawNoVerticalScrolling).toBe(true);
}

for (const width of [1440, 1100, 900]) {
  for (const rail of [200, 360] as const) {
    test(`at ${width}px with the rail pinned to ${rail}px, the vertical scrollbar tracks window height without the rail ever scrolling sideways (#83)`, async ({
      page,
    }) => {
      await railWindowGridStep(
        page,
        width,
        rail,
        "/tests/fixtures/console.html",
        true,
      );
    });
    // Same grid again, but with a name too long to fit: wrapping has to keep
    // holding while the window is actively resized, not just at rest.
    test(`at ${width}px with the rail pinned to ${rail}px and a name too long to fit, wrapping holds up while the window resizes (#83)`, async ({
      page,
    }) => {
      await railWindowGridStep(
        page,
        width,
        rail,
        "/tests/fixtures/console.html?longnames",
        false,
      );
    });
  }
}

test("the narrow navigation drawer holds to the same no-text-escapes rule (#83)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 480 });
  await page.goto("/tests/fixtures/console.html");
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Navigation", exact: true }),
  ).toBeVisible();
  await railHasNoSidewaysOverflow(page);
  await railTextNeverEscapesTheScrollBox(page);
});

// The rail must never scroll sideways AND never truncate text (owner's rule,
// stated plainly): if a line is too long for the rail, the line wraps. A
// room or DM name used to get a single-line ellipsis (app.css `.room-slug`);
// the server name used to clamp to two lines (app.css `.rail .server-name`,
// removed). Both now wrap fully instead — this checks that at the rail's
// minimum, default and maximum widths.
for (const rail of [200, 232, 360] as const) {
  test(`an unbroken name too long to fit wraps instead of truncating, with the rail at ${rail}px (#83)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/tests/fixtures/console.html?longnames");
    if (rail !== 232) {
      const separator = page.getByRole("separator", {
        name: "Resize navigation",
      });
      await separator.focus();
      await page.keyboard.press(rail === 200 ? "Home" : "End");
      await expect(separator).toHaveAttribute("aria-valuenow", String(rail));
    }

    await railHasNoSidewaysOverflow(page);
    await railTextNeverEscapesTheScrollBox(page);

    const longWord =
      "reallyreallyreallyreallyreallyreallyreallyreallylongunbrokenname";
    const checkWraps = async (locator: import("@playwright/test").Locator) => {
      await expect(locator).toBeVisible();
      const box = await locator.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        textOverflow: getComputedStyle(node).textOverflow,
        lineClamp: getComputedStyle(node).webkitLineClamp,
        innerText: (node as HTMLElement).innerText,
      }));
      // No hidden internal overflow: the box grew to fit its own text
      // instead of clipping it sideways.
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
      // Neither truncation mechanism survives: no ellipsis, no line clamp.
      expect(box.textOverflow).not.toBe("ellipsis");
      expect(["none", ""]).toContain(box.lineClamp);
      // A single line of this text is well under 30px tall; wrapping is
      // unmistakably taller than that.
      expect(box.height).toBeGreaterThan(30);
      // The full word actually made it into the rendered text — nothing was
      // cut off the end of it.
      expect(box.innerText).toContain(longWord);
    };

    await checkWraps(page.locator(".server-name"));
    await checkWraps(
      page.locator(".room-item", { hasText: "reallyreally" }).locator(".room-slug"),
    );
  });
}

// General guard: walk every element inside the rail and fail if truncation
// creeps back in anywhere, not just on the two spots #83 originally hit.
// Only a handful of things are legitimately exempt from the nowrap check —
// each is named below with why.
const RAIL_NOWRAP_ALLOWLIST = [
  // Screen-reader-only text (base.css `.sr-only`): clipped to 1x1px and
  // never visually rendered, so "nowrap" there describes nothing a sighted
  // reader could see truncated.
  ".sr-only",
];
async function railNeverTruncatesText(
  page: import("@playwright/test").Page,
) {
  const violations = await page.evaluate((allowlist) => {
    const rail = document.querySelector(".rail");
    if (!rail) return ["missing .rail"];
    const found: string[] = [];
    for (const element of [rail, ...rail.querySelectorAll("*")]) {
      const style = getComputedStyle(element);
      const describe = () =>
        `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
      if (style.textOverflow === "ellipsis")
        found.push(`${describe()}: text-overflow: ellipsis`);
      if (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "")
        found.push(`${describe()}: -webkit-line-clamp: ${style.webkitLineClamp}`);
      const hasText = element.textContent !== null && element.textContent.trim() !== "";
      if (
        style.whiteSpace === "nowrap" &&
        hasText &&
        !allowlist.some((selector) => element.matches(selector))
      )
        found.push(`${describe()}: white-space: nowrap (with text)`);
    }
    return found;
  }, RAIL_NOWRAP_ALLOWLIST);
  expect(violations).toEqual([]);
}

test("nothing inside the rail truncates its text, at rest or with a name too long to fit (#83)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/console.html");
  await railNeverTruncatesText(page);

  await page.goto("/tests/fixtures/console.html?longnames");
  await railNeverTruncatesText(page);
  const separator = page.getByRole("separator", {
    name: "Resize navigation",
  });
  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "200");
  await railNeverTruncatesText(page);
});
