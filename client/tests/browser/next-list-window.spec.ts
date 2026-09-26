import { expect, type Page, test } from "@playwright/test";

// The real list window, the owner (tests/fixtures/next-list-window.tsx): the
// sign-ins restored from the keyring, a connection per server, the list with
// several servers, what's kept on this computer, knocks, and answering the
// other windows. The views are measured in next-list.spec.ts and
// next-servers.spec.ts; this is about the wiring.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
}

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const toggle = (page: Page, name: string) => section(page, name).locator(".nx-srv-toggle");
const menuButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} options` });

test("restores every saved sign-in and leaves one live connection to each server", async ({ page }) => {
  await open(page);
  await expect(section(page, "The Good Company")).toBeVisible();
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  const asked = await did(page);
  for (const server of [HOME, GUILD, LISBON]) {
    expect(asked).toContain(`POST ${server}/auth/refresh`);
    // Every open closes what was there first, and React's development mode
    // mounts twice on purpose: what counts is that the last word is an open.
    const last = asked.filter((line) => line === `connect ${server}` || line === `disconnect ${server}`).at(-1);
    expect(last).toBe(`connect ${server}`);
  }
  // Only the first starts open, even though they arrive one by one.
  await expect(toggle(page, "The Good Company")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "Ashen Lanterns")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "Casa da Ribeira")).toHaveAttribute("aria-expanded", "false");
});

test("a server that can't be reached holds up none of the others, keeps its sign-in, and comes back without a restart (T-907)", async ({ page }) => {
  await open(page, "?down");
  // The others open well inside the longest wait (RESTORE_WAIT_MS, 5 s).
  await expect(section(page, "The Good Company")).toBeVisible({ timeout: 2_000 });
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  const notes = page.locator("[data-screen='list-notes']");
  await expect(notes).toContainText("Can't reach ashen-lanterns.example. Still trying.");
  expect(await did(page)).not.toContain(`forget ${GUILD}`);
  // Back up, and Try now brings it in: no restart, no password.
  await page.evaluate(() => window.core?.up());
  await notes.getByRole("button", { name: "Try now" }).click();
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  await expect(page.locator(".nx-srv-name")).toHaveText(["The Good Company", "Ashen Lanterns", "Casa da Ribeira"]);
  await expect(notes).toHaveCount(0);
  expect((await did(page)).filter((line) => line.startsWith("reuse"))).toEqual([]);
});

test("a stalled server: the rest open, it joins when it answers, and its token is spent once (T-907)", async ({ page }) => {
  await open(page, "?stall");
  await expect(section(page, "The Good Company")).toBeVisible({ timeout: 2_000 });
  const notes = page.locator("[data-screen='list-notes']");
  await expect(notes).toContainText("Connecting to ashen-lanterns.example…");
  // While a try is under way there's nothing to press: a second try would spend the token twice.
  await expect(notes.getByRole("button", { name: "Try now" })).toHaveCount(0);
  await page.evaluate(() => window.core?.unstall());
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  const asked = await did(page);
  expect(asked.filter((line) => line === `POST ${GUILD}/auth/refresh`)).toHaveLength(1);
  expect(asked.filter((line) => line.startsWith("reuse"))).toEqual([]);
});

test("nothing reached yet is a wait, not the sign-in screen, and it opens when the server answers (T-907)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list-window.html?one&down=good-company.example");
  const wait = page.getByRole("status");
  await expect(wait).toContainText("Can't reach good-company.example yet.", { timeout: 8_000 });
  await expect(wait).toContainText("Your sign-in is kept, and Linger keeps trying.");
  await expect(page.getByRole("textbox", { name: "Server or link" })).toHaveCount(0);
  await page.evaluate(() => window.core?.up());
  await wait.getByRole("button", { name: "Try now" }).click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  expect(await did(page)).not.toContain(`forget ${HOME}`);
  expect((await did(page)).filter((line) => line.startsWith("reuse"))).toEqual([]);

  // Or sign in somewhere else meanwhile.
  await page.goto("/tests/fixtures/next-list-window.html?one&down=good-company.example");
  await page.getByRole("button", { name: "Sign in to another server" }).click({ timeout: 8_000 });
  await expect(page.getByRole("textbox", { name: "Server or link" })).toBeVisible();
});

test("with one server it's that server's list, as before", async ({ page }) => {
  await open(page, "?one");
  await expect(page.locator(".k-titlebar")).toContainText("The Good Company");
  await expect(page.locator(".nx-srv-toggle")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Rooms" }).locator(":scope > li")).toHaveText([/general/, /listening-room/, /weekend-plans/]);
});

test("your order and Quiet are kept on this computer, across a restart", async ({ page }) => {
  await open(page);
  await menuButton(page, "Ashen Lanterns").click();
  await page.getByRole("menuitemcheckbox", { name: "Quiet" }).click();
  await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
  await menuButton(page, "Casa da Ribeira").click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.locator(".nx-srv-name")).toHaveText(["The Good Company", "Casa da Ribeira", "Ashen Lanterns"]);

  await open(page);
  await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
  await expect(page.locator(".nx-srv-name")).toHaveText(["The Good Company", "Casa da Ribeira", "Ashen Lanterns"]);
});

test("a knock from any server lands above the list's bottom and names the server; a quiet one's too", async ({ page }) => {
  await open(page);
  await menuButton(page, "Ashen Lanterns").click();
  await page.getByRole("menuitemcheckbox", { name: "Quiet" }).click();
  await page.evaluate((server) => window.core?.frame(server, { op: "knock", d: { from_user_id: "g-rui" } } as never), GUILD);
  const card = page.locator("[data-screen='knocks'] [data-kit='Notice']");
  await expect(card).toContainText("knocked.");
  await expect(card).toContainText("Ashen Lanterns");
});

test("opening a room asks the shell for the chat window, on that server", async ({ page }) => {
  await open(page);
  await toggle(page, "Casa da Ribeira").click();
  await section(page, "Casa da Ribeira").getByRole("list", { name: /Rooms/ }).getByRole("button").first().click();
  await expect.poll(async () => (await did(page)).find((line) => line.startsWith("next_open_chat"))).toContain(`"server":"${LISBON}"`);
});

test("the gear and Ctrl+, open Settings", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.keyboard.press("Control+,");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_settings"))).toHaveLength(2);
});

test("Search and Media open from the foot, and Ctrl+K opens Search", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Media" }).click();
  await page.getByRole("button", { name: "Search" }).click();
  await page.keyboard.press("Control+k");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_tool"))).toEqual([
    `next_open_tool:${JSON.stringify({ which: "media" })}`,
    `next_open_tool:${JSON.stringify({ which: "search" })}`,
    `next_open_tool:${JSON.stringify({ which: "search" })}`,
  ]);
});

test("a window that asks for a snapshot gets every server, each with a lent token", async ({ page }) => {
  await open(page);
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  await page.evaluate(() => window.core?.ask("next:snapshot", {}));
  await expect.poll(async () => (await did(page)).find((line) => line.startsWith("to chat:next:snapshot:answer")) ?? "").not.toBe("");
  const line = (await did(page)).find((one) => one.startsWith("to chat:next:snapshot:answer")) ?? "";
  const payload = JSON.parse(line.slice("to chat:next:snapshot:answer:".length)) as { answer: { servers: { server: string; lent: { token: string } }[] } };
  expect(payload.answer.servers.map((one) => one.server).sort()).toEqual([GUILD, HOME, LISBON].sort());
  for (const one of payload.answer.servers) expect(one.lent.token).toBe(`token-${one.server}`);
});

test("signing out of a server tells every window, and the rest stay signed in", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "signout", server: "https://ashen-lanterns.example" }));
  await expect(section(page, "Ashen Lanterns")).toHaveCount(0);
  await expect(section(page, "The Good Company")).toBeVisible();
  const asked = await did(page);
  expect(asked).toContain(`forget ${GUILD}`);
  expect(asked.filter((line) => line.startsWith("emit next:signedout"))).toEqual([`emit next:signedout:${JSON.stringify({ v: 1, server: GUILD })}`]);
});

test("signing out of the last server tells every window, and the list goes back to signing in", async ({ page }) => {
  await open(page, "?one");
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "signout", server: "https://good-company.example" }));
  await expect(page.locator("[data-screen='signin']")).toBeVisible();
  expect((await did(page)).filter((line) => line.startsWith("emit next:signedout"))).toEqual([`emit next:signedout:${JSON.stringify({ v: 1, server: HOME })}`]);
});

test.describe("adding a server", () => {
  test("Settings asks, and the list window shows the sign-in with a way back, keeping every server connected", async ({ page }) => {
    await open(page, "?one");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("connect ")).length).toBeGreaterThan(0);
    const before = (await did(page)).filter((line) => line.includes("connect ")).length;
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    await expect(page.getByRole("heading", { name: "Add a server." })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Server or link" })).toBeFocused();
    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await expect(page.getByRole("banner")).toContainText("The Good Company");
    // Never disconnected, or connected again, along the way.
    expect((await did(page)).filter((line) => line.includes("connect ")).length).toBe(before);
  });

  test("signing in to another server adds it to the list, below the ones you have", async ({ page }) => {
    await open(page, "?one");
    const before = (await did(page)).filter((line) => line === `disconnect ${HOME}`).length;
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    const box = page.getByRole("textbox", { name: "Server or link" });
    await box.fill("ashen-lanterns.example");
    await box.press("Enter");
    const form = page.getByRole("form", { name: "Sign in" });
    await form.getByRole("textbox", { name: "Username" }).fill("lamplighter");
    await form.getByLabel("Password").fill("porch light");
    await form.getByLabel("Password").press("Enter");
    await expect(section(page, "Ashen Lanterns")).toBeVisible();
    await expect(page.locator(".nx-srv").first()).toHaveAccessibleName("The Good Company");
    const asked = await did(page);
    expect(asked).toContain(`save ${GUILD}`);
    // Every open window hears, so it can open the new server's rooms.
    expect(asked.filter((line) => line.startsWith("emit next:signedin"))).toEqual([`emit next:signedin:${JSON.stringify({ v: 1, server: GUILD })}`]);
    expect(asked.filter((line) => line === `disconnect ${HOME}`).length).toBe(before);
  });

  test("Settings' order and Quiet reach the list, and the list says what it now is", async ({ page }) => {
    await open(page);
    await page.evaluate(([guild, home, lisbon]) => window.core?.ask("next:intent", { kind: "serverprefs", order: [lisbon, guild, home], quiet: [guild] }), [GUILD, HOME, LISBON]);
    await expect.poll(async () => page.locator(".nx-srv").evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label")))).toEqual([
      "Casa da Ribeira",
      "Ashen Lanterns",
      "The Good Company",
    ]);
    await expect(section(page, "Ashen Lanterns")).toHaveAttribute("data-quiet", "yes");
    const told = (await did(page)).filter((line) => line.startsWith("emit next:serverprefs")).at(-1);
    expect(told).toBe(`emit next:serverprefs:${JSON.stringify({ v: 1, prefs: { order: [LISBON, GUILD, HOME], quiet: [GUILD] } })}`);
  });
});

test.describe("adding a server you're already on", () => {
  test("says so, and asks nothing of it", async ({ page }) => {
    await open(page, "?one");
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    const box = page.getByRole("textbox", { name: "Server or link" });
    await box.fill("good-company.example");
    await box.press("Enter");
    await expect(page.getByText("You're already signed in to The Good Company.")).toBeVisible();
    expect((await did(page)).filter((line) => line === `GET ${HOME}/health`)).toEqual([]);
  });

  test("the voice bar stays in reach under the sign-in", async ({ page }) => {
    await open(page, "?one");
    const bar = page.getByRole("region", { name: /In voice/ });
    // Asked until the list window is listening and the seat holds: the page
    // connects twice at start (React's development mode), and a late "ready"
    // from the second connection starts the server's state afresh. Joining
    // the same room again does nothing.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.core?.ask("next:intent", { kind: "voice.join", server: "https://good-company.example", roomId: "r-general" }));
          await page.waitForTimeout(250);
          return bar.count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    await expect(page.getByRole("heading", { name: "Add a server." })).toBeVisible();
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "Leave" })).toBeVisible();
  });
});

test("Media and Search at the foot of the list open their own windows", async ({ page }) => {
  await open(page, "?one");
  const foot = page.getByRole("navigation", { name: "Media and search" });
  await foot.getByRole("button", { name: "Media" }).click();
  await foot.getByRole("button", { name: "Search" }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_tool"))).toEqual([
    `next_open_tool:${JSON.stringify({ which: "media" })}`,
    `next_open_tool:${JSON.stringify({ which: "search" })}`,
  ]);
});

test("a search hit asked for from another window opens the chat window at that message", async ({ page }) => {
  await open(page, "?one");
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        window.core?.ask("next:intent", { kind: "open", server: "https://good-company.example", roomId: "r-general", conversation: "room", messageId: "m000005" }),
      );
      return (await did(page)).filter((line) => line.startsWith("next_open_chat")).length;
    })
    .toBeGreaterThan(0);
  expect((await did(page)).find((line) => line.startsWith("next_open_chat"))).toBe(
    `next_open_chat:${JSON.stringify({ server: "https://good-company.example", room: "r-general", message: "m000005" })}`,
  );
});

test("a clicked desktop banner opens its conversation at the message; one from a server you've left does nothing (decision 20)", async ({ page }) => {
  await open(page, "?one");
  // Nonsense and a server not signed in are ignored.
  await page.evaluate(() => {
    window.core?.banner({ server: "https://good-company.example", room: 7 });
    window.core?.banner({ server: "https://elsewhere.example", room: "r-general", message: "m000001" });
  });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.core?.banner({ server: "https://good-company.example", room: "r-general", message: "m000005" }));
      return (await did(page)).filter((line) => line.startsWith("next_open_chat"));
    })
    .not.toEqual([]);
  expect(new Set((await did(page)).filter((line) => line.startsWith("next_open_chat")))).toEqual(
    new Set([`next_open_chat:${JSON.stringify({ server: HOME, room: "r-general", message: "m000005" })}`]),
  );
});

test("the list tells the desktop what closing it does: the tray by default, and what Settings changes it to", async ({ page }) => {
  await open(page, "?one");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_close_to_tray")).at(0)).toBe(
    `next_close_to_tray:${JSON.stringify({ on: true })}`,
  );
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "tray", on: false }));
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_close_to_tray")).at(-1)).toBe(
    `next_close_to_tray:${JSON.stringify({ on: false })}`,
  );
});

test("the tray menu's Mute and Leave follow voice, and do what they say while the list is hidden", async ({ page }) => {
  await open(page, "?one");
  const trayLines = async () => (await did(page)).filter((line) => line.startsWith("next_tray_voice"));
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: false, muted: false })}`);
  const bar = page.getByRole("region", { name: /In voice/ });
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.core?.ask("next:intent", { kind: "voice.join", server: "https://good-company.example", roomId: "r-general" }));
        await page.waitForTimeout(250);
        return bar.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: true, muted: false })}`);
  await page.evaluate(() => window.core?.tray("mute"));
  await expect(bar.getByRole("button", { name: "Muted" })).toBeVisible();
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: true, muted: true })}`);
  await page.evaluate(() => window.core?.tray("leave"));
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: false, muted: false })}`);
});

// The foot's standing lines (decision 1): said only while true.
const notes = (page: Page) => page.locator("[data-screen='list-notes'] .nx-note");

test("all's well: the foot says nothing, and a new version is looked for at launch", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(10_000);
  await expect(section(page, "Casa da Ribeira")).toBeVisible();
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
  expect(await did(page)).toContain("update_check");
});

test("a server that can't be reached for a few seconds says so by name, with the reason on hover, and the line goes when it's back", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  // Every server connected first, and nothing said about it.
  await page.clock.runFor(6_000);
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
  await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 4000, reason: "connection refused" }), GUILD);
  // A blip is never said: only a connection still down after the grace.
  await page.clock.runFor(4_000);
  await expect(notes(page)).toHaveCount(0);
  await page.clock.runFor(1_500);
  await expect(notes(page)).toHaveText(["Can't reach Ashen Lanterns. Still trying."]);
  await expect(notes(page)).toHaveAttribute("title", "connection refused");
  // Still down while it tries again: the same line, not a new grace.
  await page.evaluate((server) => window.core?.status(server, { kind: "connecting" }), GUILD);
  await expect(notes(page)).toHaveText(["Connecting to Ashen Lanterns…"]);
  await page.evaluate((server) => window.core?.status(server, { kind: "ready", latency_ms: 30 }), GUILD);
  await expect(notes(page)).toHaveCount(0);
});

test("a new version gets one quiet line, and Update… opens Settings where it's installed", async ({ page }) => {
  await open(page, "?one&update");
  await expect(notes(page)).toHaveText(["Linger 0.4.1 is ready.Update…"]);
  await notes(page).getByRole("button", { name: "Update…" }).click();
  expect((await did(page)).filter((line) => line.startsWith("next_open_settings")).at(-1)).toBe(
    `next_open_settings:${JSON.stringify({ section: "account" })}`,
  );
});

test("a computer that can't keep sign-ins keeps saying so under the list, once signed in", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list-window.html?one&signedout&nokeyring");
  await page.getByRole("textbox", { name: "Server or link" }).fill("good-company.example");
  await page.getByRole("textbox", { name: "Server or link" }).press("Enter");
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByRole("textbox", { name: "Username" }).fill("matt");
  await form.getByLabel("Password").fill("porch light");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await expect(notes(page)).toHaveText(["Sign-ins aren't remembered on this computer."]);
  await expect(notes(page)).toHaveAttribute("title", /No usable keyring/);
});

test("the foot's lines fit the list: nothing clipped or sideways, the words lined up", async ({ page }) => {
  await page.clock.install();
  await open(page, "?update");
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  await page.clock.runFor(1_000);
  await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 4000, reason: "refused" }), GUILD);
  await page.clock.runFor(6_000);
  await expect(notes(page)).toHaveCount(2);
  const measured = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".nx-note")].map((line) => {
      const words = line.querySelector<HTMLElement>(".nx-note-words");
      const box = line.getBoundingClientRect();
      return {
        left: words?.getBoundingClientRect().left ?? -1,
        inside: box.right <= document.documentElement.clientWidth && box.left >= 0,
        cut: words ? words.scrollWidth > words.clientWidth : true,
      };
    }),
  );
  expect(measured.every((line) => line.inside && !line.cut)).toBe(true);
  expect(new Set(measured.map((line) => line.left)).size).toBe(1);
});

test("a voice chip opens that person's volume: it's heard at once, kept on this computer, and Escape gives the chip back", async ({ page }) => {
  await open(page, "?one");
  const bar = page.getByRole("region", { name: /In voice/ });
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.core?.ask("next:intent", { kind: "voice.join", server: "https://good-company.example", roomId: "r-general" }));
        await page.waitForTimeout(250);
        return bar.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  // Your own chip opens nothing.
  await expect(bar.getByRole("button", { name: /^you/ })).toHaveCount(0);
  const eli = bar.getByRole("button", { name: "Eli's volume, 100%" });
  await eli.click();
  const card = page.getByRole("dialog", { name: "Eli's volume" });
  const slider = card.getByRole("slider", { name: "How loud Eli is for you" });
  await expect(slider).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "110%");
  const volumes = async () => (await did(page)).filter((line) => line.startsWith("voice_volume"));
  await expect.poll(async () => (await volumes()).at(-1)).toMatch(/"volume":1\.1/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("linger.voice.volumes:https://good-company.example") ?? "{}"))).toEqual({ "u-eli": 1.1 });
  await card.getByRole("button", { name: "Back to 100%" }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "100%");
  await expect(card.getByRole("button", { name: "Back to 100%" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Eli's volume, 100%" })).toBeFocused();
});

test("the volume card sits over its chip, inside the window, with nothing clipped", async ({ page }) => {
  await open(page, "?one");
  const bar = page.getByRole("region", { name: /In voice/ });
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.core?.ask("next:intent", { kind: "voice.join", server: "https://good-company.example", roomId: "r-general" }));
        await page.waitForTimeout(250);
        return bar.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  const chip = bar.getByRole("button", { name: /^Jules's volume/ });
  await chip.click();
  const card = page.getByRole("dialog", { name: "Jules's volume" });
  await expect(card).toBeVisible();
  await page.waitForTimeout(400);
  const [cardBox, chipBox] = [await card.boundingBox(), await chip.boundingBox()];
  const width = page.viewportSize()?.width ?? 0;
  expect(cardBox && chipBox && cardBox.y + cardBox.height <= chipBox.y).toBe(true);
  expect(cardBox && cardBox.x >= 0 && cardBox.x + cardBox.width <= width).toBe(true);
  const cut = await card.evaluate((node) => [...node.querySelectorAll<HTMLElement>(".nx-volume-note, .nx-volume-value")].some((one) => one.scrollWidth > one.clientWidth));
  expect(cut).toBe(false);
  // The bar grows under it (two more people join, and the chips wrap): the card follows the chip up.
  await page.evaluate(() =>
    window.core?.frame("https://good-company.example", {
      op: "voice.state",
      d: {
        room_id: "r-general",
        peers: [
          { session_id: "s-good-company.example", user_id: "u-matt" },
          { session_id: "s-dave", user_id: "u-dave" },
          { session_id: "s-callie", user_id: "u-callie" },
          { session_id: "s-eli", user_id: "u-eli" },
          { session_id: "s-jules", user_id: "u-jules" },
        ],
      },
    } as never),
  );
  await page.waitForTimeout(300);
  const [after, chipAfter] = [await card.boundingBox(), await chip.boundingBox()];
  expect(after && chipAfter && after.y + after.height <= chipAfter.y).toBe(true);
});

// Arrivals (decisions 12 and 13): "Callie came into #general".
const arrive = (page: Page, server: string, user: string, room: string | null) =>
  page.evaluate(
    ([server, user, room]) =>
      window.core?.frame(server, { op: "presence.update", d: { user_id: user, state: room ? "in_room" : "around", room_id: room, away_message: null } } as never),
    [server, user, room] as const,
  );

test("somebody coming into a room gets a card that goes by itself; nothing on connecting", async ({ page }) => {
  await page.clock.install();
  await open(page, "?one");
  await page.clock.runFor(1_000);
  // Everybody already there when the list connected is not arriving.
  await expect(page.locator("[data-screen='knocks']")).toHaveCount(0);
  await arrive(page, HOME, "u-callie", "r-general");
  const card = page.locator("[data-screen='knocks'] .k-notice");
  await expect(card).toHaveText("Callie came into #general.");
  await expect(card).toHaveAttribute("role", "status");
  // It never takes the cursor.
  expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(true);
  // A minute before the same person gets another.
  await arrive(page, HOME, "u-callie", null);
  await arrive(page, HOME, "u-callie", "r-listening");
  await expect(card).toHaveCount(1);
  await page.clock.runFor(6_500);
  await expect(card).toHaveCount(0);
});

test("no arrival cards from a Quiet server, in quiet hours, or with them turned off", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(1_000);
  // Not quiet yet: Vesper coming in is said.
  await arrive(page, GUILD, "a-vesper", "a-general");
  await expect(page.locator("[data-screen='knocks'] .k-notice")).toContainText("Vesper came into #general.");
  await page.clock.runFor(7_000);
  await menuButton(page, "Ashen Lanterns").click();
  await page.getByRole("menuitemcheckbox", { name: "Quiet" }).click();
  await arrive(page, GUILD, "a-halden", "a-general");
  await page.clock.runFor(500);
  await expect(page.locator("[data-screen='knocks']")).toHaveCount(0);
  // Quiet hours, set to the hour starting now, hold them.
  await page.evaluate(() => {
    const minute = new Date().getHours() * 60 + new Date().getMinutes();
    localStorage.setItem("linger.sound.quietHours", "true");
    localStorage.setItem("linger.sound.quietFrom", String(minute));
    localStorage.setItem("linger.sound.quietUntil", String((minute + 60) % 1440));
  });
  await arrive(page, HOME, "u-callie", "r-general");
  await page.clock.runFor(500);
  await expect(page.locator("[data-screen='knocks']")).toHaveCount(0);
  // Turned off in Settings, on this computer.
  await page.evaluate(() => {
    localStorage.setItem("linger.sound.quietHours", "false");
    localStorage.setItem("linger.next.arrivalCards", "false");
  });
  await arrive(page, HOME, "u-callie", "r-listening");
  await page.clock.runFor(500);
  await expect(page.locator("[data-screen='knocks']")).toHaveCount(0);
});
