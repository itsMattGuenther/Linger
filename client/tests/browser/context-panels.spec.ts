import { expect, test } from "@playwright/test";
import type { Room } from "../../src/generated/Room";

async function focusColors(control: import("@playwright/test").Locator) {
  return control.evaluate((node) => {
    const probe = document.createElement("span");
    node.append(probe);
    probe.style.color = "var(--focus-ring)";
    const focus = getComputedStyle(probe).color;
    probe.style.color = "var(--accent)";
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      accent,
      focus,
      outline: getComputedStyle(node).outlineColor,
    };
  });
}

test("compact controls retain names and clear targets; destinations anchor above the footer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/fixtures/console.html");
  for (const name of [
    "Add a server",
    "Create a room",
    "Settings",
    "Server options",
    "Collapse voice participants",
  ]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveText("");
    await expect(control).toHaveAttribute("data-tooltip", name);
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(36);
    expect(box?.height).toBeGreaterThanOrEqual(36);
  }
  const places = await page.locator(".rail-places").boundingBox();
  const footer = await page.locator(".rail-self").boundingBox();
  expect(places).not.toBeNull();
  expect(footer).not.toBeNull();
  if (!places || !footer) return;
  expect(places.y).toBeGreaterThan(700);
  expect(footer.y - places.y - places.height).toBeLessThanOrEqual(32);
  expect(footer.y).toBeGreaterThanOrEqual(places.y + places.height);
});

test("the voice chevron only collapses participants and Join sits on the right", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const heading = await page.locator(".voice-heading").boundingBox();
  const join = await page
    .getByRole("button", { name: "Join Voice", exact: true })
    .boundingBox();
  const bar = await page.locator(".voice-bar").boundingBox();
  expect(heading && join && bar).toBeTruthy();
  if (!heading || !join || !bar) return;
  expect(join.x).toBeGreaterThan(heading.x + heading.width);
  expect(bar.x + bar.width - join.x - join.width).toBeLessThan(32);
  await expect(page.locator(".voice-person svg")).toHaveCount(0);
  const toggle = page.getByRole("button", {
    name: "Collapse voice participants",
  });
  await toggle.click();
  await expect(page.locator(".voice-seats")).toBeHidden();
  await expect(page.locator(".roster")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Join Voice", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand voice participants" }).click();
  await expect(page.locator(".voice-seats")).toBeVisible();
});

test("a member popout opens from keyboard and right-click, with separated actions and focus restoration", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const jules = page.locator(".roster").getByRole("button", { name: /Jules/ });
  await jules.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", {
    name: "Jules's profile",
    exact: true,
  });
  const close = panel.getByRole("button", {
    name: "Close Jules's profile",
    exact: true,
  });
  await expect(close).toBeFocused();
  const message = await panel
    .getByRole("button", { name: "Message", exact: true })
    .boundingBox();
  const knock = await panel
    .getByRole("button", { name: "Knock", exact: true })
    .boundingBox();
  expect(message && knock).toBeTruthy();
  if (!message || !knock) return;
  expect(Math.abs(message.y - knock.y)).toBeLessThan(1);
  expect(knock.x - message.x - message.width).toBeGreaterThanOrEqual(12);
  await page.keyboard.press("Shift+Tab");
  await expect(
    panel.getByRole("button", { name: "Knock", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(jules).toBeFocused();
  await jules.click({ button: "right" });
  await expect(panel).toBeVisible();
  await page.mouse.click(400, 700);
  await expect(panel).toHaveCount(0);
  await expect(jules).toBeFocused();
});

test("a member popout inside narrow People keeps focus and closes only its own layer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 480 });
  await page.addInitScript(() =>
    localStorage.setItem("linger.interface.scale", "200"),
  );
  await page.goto("/tests/fixtures/console.html");
  const people = page.getByRole("button", { name: "People", exact: true });
  await people.click();
  const drawer = page.getByRole("dialog", { name: "People", exact: true });
  const jules = drawer.getByRole("button", { name: /Jules/ });
  await jules.click();
  const panel = page.getByRole("dialog", {
    name: "Jules's profile",
    exact: true,
  });
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= 760 &&
      box.y + box.height <= 480,
  ).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(
    panel.getByRole("button", { name: "Knock", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "Close Jules's profile", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(jules).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(people).toBeFocused();
});

test("server management stays in the selected server menu", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await expect(
    page.getByRole("button", { name: "Host tools", exact: true }),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "Server options",
    exact: true,
  });
  await trigger.click();
  const panel = page.getByRole("dialog", {
    name: "Server options",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: "Invite people", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await panel
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Server Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".host-member").filter({ hasText: "Jules" }),
  ).toBeVisible();
});

test("context panels keep pointer autofocus quiet and show restrained keyboard focus (#96)", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.locator(".frame").evaluate((node) => {
    (node as HTMLElement).style.setProperty("--accent", "var(--name-lime)");
  });
  const trigger = page.getByRole("button", {
    name: "Server options",
    exact: true,
  });
  const panel = page.getByRole("dialog", {
    name: "Server options",
    exact: true,
  });
  const close = panel.getByRole("button", {
    name: "Close Server options",
    exact: true,
  });

  // A pointer open focuses the panel itself, not its close button (#143).
  await trigger.click();
  await expect(panel).toBeFocused();
  await expect(close).not.toBeFocused();
  await expect(panel).toHaveCSS("outline-style", "none");
  await expect(close).toHaveCSS("outline-style", "none");
  await expect
    .poll(() =>
      close.evaluate((node) => getComputedStyle(node, "::after").visibility),
    )
    .toBe("hidden");

  // The first Tab enters at the close button and shows it as keyboard focus.
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS("outline-style", "solid");
  await expect
    .poll(() =>
      close.evaluate((node) => getComputedStyle(node, "::after").visibility),
    )
    .toBe("visible");

  await page.keyboard.press("Tab");
  const settings = panel.getByRole("button", {
    name: "Server Settings",
    exact: true,
  });
  await expect(settings).toBeFocused();
  await expect(settings).toHaveCSS("outline-style", "solid");
  await expect(settings).toHaveCSS("outline-width", "1px");
  const colors = await focusColors(settings);
  expect(colors.outline).toBe(colors.focus);
  expect(colors.outline).not.toBe(colors.accent);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Space");
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS("outline-style", "solid");
  await expect
    .poll(() =>
      close.evaluate((node) => getComputedStyle(node, "::after").visibility),
    )
    .toBe("visible");
  const closeColors = await focusColors(close);
  expect(closeColors.outline).toBe(closeColors.focus);
  expect(closeColors.outline).not.toBe(closeColors.accent);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const width of [1100, 760]) {
  test(`the final porch icon loads, centers and fits at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/tests/fixtures/welcome.html");
    const logo = page.getByRole("img", {
      name: "Linger porch",
    });
    await expect(logo).toBeVisible();
    await expect
      .poll(() =>
        logo.evaluate(
          (node) =>
            node instanceof HTMLImageElement &&
            node.complete &&
            node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const box = await logo.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(box.width).toBeLessThan(width - 32);
    expect(box.width / box.height).toBeCloseTo(388 / 384, 1);
    expect(box.width).toBeGreaterThanOrEqual(140);
    await expect(
      page.locator(".auth-icon, .auth-wordmark, .auth-tagline"),
    ).toHaveCount(0);
    await expect(
      page.getByText("Good company. No hurry.", { exact: true }),
    ).toHaveCount(0);
  });
}

test("a late DM response cannot reopen a dismissed member popout", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  await page.evaluate(() => {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/dms") && init?.method === "POST") {
        document.documentElement.dataset.dmPending = "yes";
        await new Promise<void>((resolve) =>
          document.addEventListener("finish-dm", () => resolve(), {
            once: true,
          }),
        );
        const room: Room = {
          id: "dm-jules",
          slug: "dm-jules",
          name: "dm-jules",
          kind: "dm",
          topic: null,
          member_ids: ["matt", "jules"],
          position: 0,
          archived_at: null,
          last_message_id: null,
        };
        return new Response(JSON.stringify(room), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return previous(input, init);
    };
  });
  await page.locator(".roster").getByRole("button", { name: /Jules/ }).click();
  await page.getByRole("button", { name: "Message", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-dm-pending", "yes");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-dm")));
  await expect(page.locator(".rail-dms")).toContainText("Jules");
  await expect(
    page.getByRole("dialog", { name: "Jules's profile", exact: true }),
  ).toHaveCount(0);
});

/** The close button's tooltip, which is drawn by its `::after`. */
function tooltipOf(close: import("@playwright/test").Locator) {
  return close.evaluate((node) => getComputedStyle(node, "::after").visibility);
}

test("opening any panel with the mouse highlights nothing and shows no tooltip, even straight after a keyboard open (#143)", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/console.html");
  const panels = [
    {
      trigger: page.getByRole("button", { name: "Server options", exact: true }),
      name: "Server options",
    },
    {
      trigger: page.locator(".roster").getByRole("button", { name: /Jules/ }),
      name: "Jules's profile",
    },
    {
      trigger: page.locator(".voice-seats").getByRole("button", { name: /Jules/ }).first(),
      name: "Voice options for Jules",
    },
  ];

  for (const { trigger, name } of panels) {
    const panel = page.getByRole("dialog", { name, exact: true });
    const close = panel.getByRole("button", { name: `Close ${name}`, exact: true });

    // Keyboard first: Escape hands focus back to the opener with its ring on,
    // which is exactly the state the old check misread as "opened by keyboard"
    // on the next mouse click.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    for (const when of ["first click after a keyboard open", "second click"]) {
      const pass = `${name}, ${when}`;
      await trigger.click();
      await expect(panel, pass).toBeVisible();
      await expect(panel, pass).toBeFocused();
      await expect(close, pass).not.toBeFocused();
      await expect(close, pass).toHaveCSS("outline-style", "none");
      await expect.poll(() => tooltipOf(close), pass).toBe("hidden");

      // Hover still names the button.
      await close.hover();
      await expect.poll(() => tooltipOf(close), pass).toBe("visible");
      await page.mouse.move(1, 1);
      await expect.poll(() => tooltipOf(close), pass).toBe("hidden");

      // Shift+Tab from the panel wraps to its last control, not out of it.
      // (For the voice panel out of voice, the close button is the only one.)
      await page.keyboard.press("Shift+Tab");
      await expect(
        panel.locator("button:visible, input:visible, a[href]:visible").last(),
        pass,
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(panel, pass).toHaveCount(0);
      await expect(trigger, pass).toBeFocused();
    }
  }
});

for (const theme of ["dark", "light"]) {
  test(`the account footer is your name and Settings, with no "you" under it, ${theme} (#171)`, async ({ page }) => {
    await page.goto("/tests/fixtures/console.html");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.evaluate(() => document.fonts.ready);

    const account = page.getByRole("region", { name: "Your account" });
    await expect(account).toBeVisible();
    await expect(account.getByText("you", { exact: true })).toHaveCount(0);
    await expect(account.locator(".meta")).toHaveCount(0);

    const layout = () => page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const name = rect(".rail-self-name"), cog = rect(".rail-settings"), self = rect(".rail-self");
      const account = rect(".rail-account");
      return {
        offset: name.top + name.height / 2 - (cog.top + cog.height / 2),
        cogInside: cog.right <= account.right + 0.5,
        rowHeight: self.height,
        cogHeight: cog.height,
        nameHeight: name.height,
      };
    });
    const short = await layout();
    expect(Math.abs(short.offset), "name and Settings share a middle").toBeLessThan(1);
    // One line: the row is the Settings button plus the space above it, not
    // a second line of text.
    expect(short.rowHeight).toBeLessThanOrEqual(short.cogHeight + 8.5);

    // A long name still wraps and leaves the cog inside the rail.
    await page.locator(".rail-self-name").evaluate((node) => {
      node.textContent = "Somebody With A Remarkably Long Display Name Indeed";
    });
    const long = await layout();
    expect(long.nameHeight, "the long name wraps").toBeGreaterThan(short.nameHeight * 1.5);
    expect(long.cogInside, "Settings stays inside the rail").toBe(true);
  });
}
