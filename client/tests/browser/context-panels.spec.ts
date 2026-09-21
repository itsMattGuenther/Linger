import { expect, test } from "@playwright/test";
import type { Room } from "../../src/generated/Room";

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
    .getByRole("button", { name: "Join voice", exact: true })
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
    page.getByRole("button", { name: "Join voice", exact: true }),
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
