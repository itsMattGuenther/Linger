import { expect, type Page, test } from "@playwright/test";
import { catchAnimations, stopCatching } from "./caught";

// The real list window, the owner (tests/fixtures/next-list-window.tsx): the
// sign-ins restored from the keyring, a connection per server, the list with
// several servers, what's kept on this computer, knocks, and answering the
// other windows. The views are measured in next-list.spec.ts and
// next-servers.spec.ts; this is about the wiring.

test.use({ viewport: { width: 340, height: 820 } });

const HOME = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";
const LISBON = "https://casa-da-ribeira.example";
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5"><rect width="8" height="5" fill="#3a2d3f"/></svg>`;

async function open(page: Page, query = "") {
  await page.goto(`/tests/fixtures/next-list-window.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await settled(page);
}

/**
 * The unreachable server comes back the moment Try now is pressed. Bringing
 * it back first and then pressing left a gap: the app tries again by itself
 * 5 s after a failure (RETRY_AFTER_MS), and on a busy machine that try could
 * land in the gap, bring the server in, and take Try now away before it was
 * pressed. The click then waited out the test's whole time (#528).
 */
async function upOnTryNow(page: Page) {
  await page.evaluate(() =>
    document.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("button")?.textContent?.trim() === "Try now") window.core?.up();
      },
      { capture: true },
    ),
  );
}

/**
 * Every connection the page opened has had its `ready`. In development React
 * starts the list twice, so each server is connected twice, and a `ready`
 * clears what the rooms had loaded. The page's fake gives both the same
 * session, where a real server's second would be new, so a room opened
 * between the two would sit empty (#355): tests start once both are in.
 */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
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
  // Every one starts folded, even though they arrive one by one (#712).
  await expect(toggle(page, "The Good Company")).toHaveAttribute("aria-expanded", "false");
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
  await upOnTryNow(page);
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
  await upOnTryNow(page);
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
  // And your group DM after the rooms (#351).
  await expect(page.getByRole("list", { name: "Rooms" }).locator(":scope > li")).toHaveText([/general/, /listening-room/, /weekend-plans/, /Eli and Sam/]);
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

test("a knock on your door rocks the whole list, a second starts it over, and reduced motion keeps it still (#211)", async ({ page }) => {
  await open(page);
  const list = page.locator("[data-screen='list']");
  await expect(list).not.toHaveAttribute("data-rock");
  // Each rock held where it starts, to be measured: it's over in under half a
  // second, often before a busy browser has answered the next question (#528).
  await catchAnimations(page, "[data-screen='list']", { hold: true });
  const knock = (from: string) =>
    page.evaluate(([server, who]) => window.core?.frame(server, { op: "knock", d: { from_user_id: who } } as never), [GUILD, from] as const);
  await knock("g-rui");
  await expect(list).toHaveAttribute("data-rock", "a");
  expect(await list.evaluate((node) => getComputedStyle(node).animationName)).toBe("nx-list-rock-a");
  // It moves: a tenth of the way in, the list is off to the left.
  const leftAt = (ms: number) =>
    list.evaluate((node, at) => {
      const [rock] = node.getAnimations();
      if (!rock) return null;
      rock.pause();
      rock.currentTime = at;
      return new DOMMatrix(getComputedStyle(node).transform).m41;
    }, ms);
  await expect.poll(() => leftAt(70)).toBeLessThan(-2);
  await knock("g-rui");
  await expect(list).toHaveAttribute("data-rock", "b");
  expect(await list.evaluate((node) => getComputedStyle(node).animationName)).toBe("nx-list-rock-b");

  // With less motion it runs as it would, uncaught: over at once.
  await stopCatching(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await knock("g-rui");
  await expect(list).toHaveAttribute("data-rock", "a");
  expect(await list.evaluate((node) => getComputedStyle(node).animationDuration)).toBe("0.001s");
  expect(await leftAt(0.1) ?? 0).toBe(0);
  // The card still says who knocked.
  await expect(page.locator("[data-screen='knocks'] [data-kit='Notice']").first()).toContainText("knocked.");
});

test("a second knock from somebody takes their first card's place, and forty at once show the newest three (#512)", async ({ page }) => {
  await open(page);
  const cards = page.locator("[data-screen='knocks'] [data-kit='Notice']");
  const knock = (server: string, from: string) =>
    page.evaluate(([to, who]) => window.core?.frame(to, { op: "knock", d: { from_user_id: who } } as never), [server, from] as const);
  await knock(GUILD, "g-rui");
  await expect(cards).toHaveCount(1);
  await knock(GUILD, "g-rui");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("knocked.");
  // Forty people on two servers: forty cards covered the whole list for eight seconds.
  for (let n = 0; n < 40; n += 1) await knock(n % 2 === 0 ? GUILD : HOME, `crowd-${n}`);
  await expect(cards).toHaveCount(3);
});

// The list is the window's exact size, so a rock takes it a few pixels past the
// window's edges. The page grew scroll bars to follow, which Windows draws, on
// and off with each swing (#251). Nothing past the edge is on screen anyway.
test("a rock never gives the page anything to scroll (#251)", async ({ page }) => {
  await open(page);
  const list = page.locator("[data-screen='list']");
  // Held where it starts: it's over in under half a second (#528).
  await catchAnimations(page, "[data-screen='list']", { hold: true });
  await page.evaluate((server) => window.core?.frame(server, { op: "knock", d: { from_user_id: "g-rui" } } as never), GUILD);
  await expect(list).toHaveAttribute("data-rock", "a");
  // Held at each swing: left and tilted, right, back.
  for (const at of [70, 140, 280, 350]) {
    const overflow = await list.evaluate((node, ms) => {
      const [rock] = node.getAnimations();
      if (!rock) return null;
      rock.pause();
      rock.currentTime = ms;
      const page = document.scrollingElement ?? document.documentElement;
      window.scrollTo(50, 50);
      return {
        moved: new DOMMatrix(getComputedStyle(node).transform).m41 !== 0,
        wide: page.scrollWidth - page.clientWidth,
        tall: page.scrollHeight - page.clientHeight,
        scrolled: [window.scrollX, window.scrollY],
      };
    }, at);
    expect(overflow, `at ${at}ms`).toEqual({ moved: true, wide: 0, tall: 0, scrolled: [0, 0] });
  }
});

test("opening a room shows it beside the list, on that server (#337)", async ({ page }) => {
  await open(page);
  await toggle(page, "Casa da Ribeira").click();
  await section(page, "Casa da Ribeira").getByRole("list", { name: /Rooms/ }).getByRole("button").first().click();
  await expect(page.getByRole("tab", { name: /, Casa da Ribeira$/, selected: true })).toBeVisible();
  // In this window: the shell is asked for no other.
  expect((await did(page)).filter((line) => line.startsWith("next_open_"))).toEqual([]);
});

// The website's and the hype kit's screenshots are taken from this page, so
// #general's photo has to load in it. Its smaller copy was left a `data:`
// address, the window put the server's in front of it, and every shot showed
// "Couldn't load this picture." where the photo should be (#643).
test("#general's pictures all load from the server, the smaller copy too (#643)", async ({ page }) => {
  await page.route(`${HOME}/media/**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: PHOTO }));
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page, "?one");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  const conversation = page.getByRole("tabpanel", { name: "#general" });
  const pictures = conversation.locator(".nx-att-image img");
  await expect(pictures).toHaveCount(1);
  // They load only once they're near the view.
  await pictures.first().scrollIntoViewIfNeeded();
  await expect.poll(() => pictures.evaluateAll((all) => all.map((img) => (img as HTMLImageElement).naturalWidth > 0))).toEqual([true]);
  await expect(conversation.locator("[data-picture='failed']")).toHaveCount(0);
});

test("a session that starts over asks where you'd read to again, so what you read elsewhere stops looking new (#453)", async ({ page }) => {
  await open(page, "?one");
  const fresh = page.getByRole("list", { name: "Rooms" }).locator("[data-fresh='yes']");
  await expect(fresh).toHaveText([/listening-room/, /weekend-plans/]);
  const asked = async () => (await did(page)).filter((line) => line === `GET ${HOME}/read`).length;
  const before = await asked();
  // Read on the phone while this computer slept, past the server's two
  // minutes: it comes back to a fresh session, not a resumed one.
  await page.evaluate((server) => window.core?.restart(server, { "r-listening": "m000020" }), HOME);
  await expect.poll(asked).toBe(before + 1);
  // #weekend-plans wasn't read anywhere: still new.
  await expect(fresh).toHaveText([/weekend-plans/]);
});

test("the gear and Ctrl+, open Settings", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.keyboard.press("Control+,");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_settings"))).toHaveLength(2);
});

test("your own card's Edit profile asks the shell for Settings, on Profile (#271)", async ({ page }) => {
  await open(page, "?one");
  await page.getByRole("region", { name: "You" }).getByRole("button", { name: "Matt" }).click();
  const card = page.getByRole("dialog", { name: "Matt" });
  await expect(card).toContainText("This is how friends see you");
  await card.getByRole("button", { name: "Edit profile" }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_settings")))
    .toEqual([`next_open_settings:${JSON.stringify({ section: "profile", server: null })}`]);
});

test("a server's Edit your profile here asks the shell for Settings on that server's Profile (#719)", async ({ page }) => {
  await open(page);
  const guild = page.getByRole("region", { name: "Ashen Lanterns", exact: true });
  await guild.locator(".nx-srv-head").hover();
  await page.getByRole("button", { name: "Ashen Lanterns options" }).click();
  await page.getByRole("menuitem", { name: "Edit your profile here" }).click();
  await expect
    .poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_settings")))
    .toEqual([`next_open_settings:${JSON.stringify({ section: "profile", server: GUILD })}`]);
});

test("Search and Media open from the foot as tabs beside the list, and Ctrl+K opens Search (#337)", async ({ page }) => {
  // Room for both: in a list-sized window the tab would take the whole window.
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page);
  const foot = page.getByRole("navigation", { name: "Media and search" });
  await foot.getByRole("button", { name: "Media" }).click();
  await expect(page.getByRole("tab", { name: "Media", selected: true })).toBeVisible();
  await foot.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("tab", { name: "Search", selected: true })).toBeVisible();
  await page.getByRole("tab", { name: "Media" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("tab", { name: "Search", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search", exact: true })).toBeFocused();
  // One of each, in this window: the shell is asked for no other.
  await expect(page.getByRole("tab")).toHaveCount(2);
  expect((await did(page)).filter((line) => line.startsWith("next_open_tool"))).toEqual([]);
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

test("a sign-in refused after signing out on purpose says nothing about it (#650)", async ({ page }) => {
  // Deleting your account signs the app out of that server, and the server
  // has already ended every sign-in: the token the connection asks for on
  // its way out is refused. That isn't news to whoever just deleted it.
  await open(page, "?one");
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  const refreshes = async () => (await did(page)).filter((line) => line.endsWith("/auth/refresh")).length;
  const before = await refreshes();
  await page.evaluate(() => window.core?.refuseNext());
  // The first ask hands over the token the app holds; asked again, the
  // connection wants a fresh one, and that refresh is the one refused.
  await page.evaluate(() => window.core?.status("https://good-company.example", { kind: "needs_token" }));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.core?.status("https://good-company.example", { kind: "needs_token" }));
  await expect.poll(refreshes).toBeGreaterThan(before);
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "signout", server: "https://good-company.example" }));
  await expect(page.locator("[data-screen='signin']")).toBeVisible();
  await page.evaluate(() => window.core?.unstall());
  // The refusal lands a moment later, and nothing is waiting on it to show.
  await page.waitForTimeout(300);
  await expect(page.locator("[data-screen='signin']")).not.toContainText("sign-in expired");
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

  test("a link an invite page sends while Linger runs opens the sign-in for it, the link in the box, asking nothing yet (#607)", async ({ page }) => {
    await open(page, "?one");
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("ready ")).length).toBeGreaterThan(0);
    const link = "https://ashen-lanterns.example/invite/LANTERN7";
    await page.evaluate((sent) => window.core?.link(sent), link);
    await expect(page.getByRole("heading", { name: "Add a server." })).toBeVisible();
    const box = page.getByRole("textbox", { name: "Server or link" });
    await expect(box).toHaveValue(link);
    expect((await did(page)).filter((line) => line.startsWith("GET https://ashen-lanterns.example"))).toEqual([]);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("form", { name: "Join" }).getByText("You're joining Ashen Lanterns.", { exact: false })).toBeVisible();
    // Back to the list: the link is used up, and adding a server from
    // Settings later starts with an empty box.
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    await expect(page.getByRole("heading", { name: "Add a server." })).toBeVisible();
    await expect(box).toHaveValue("");
    // The same link opened again is offered again.
    await page.getByRole("button", { name: "Back to the list" }).click();
    await page.evaluate((sent) => window.core?.link(sent), link);
    await expect(box).toHaveValue(link);
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
    // Signing back in at launch asks it which app it works with (#793); the paste asks nothing more.
    const asked = (await did(page)).filter((line) => line === `GET ${HOME}/health`).length;
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    const box = page.getByRole("textbox", { name: "Server or link" });
    await box.fill("good-company.example");
    await box.press("Enter");
    await expect(page.getByText("You're already signed in to The Good Company.")).toBeVisible();
    expect((await did(page)).filter((line) => line === `GET ${HOME}/health`)).toHaveLength(asked);
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

test("with each in its own window, Media and Search at the foot of the list open their own windows", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.next.conversations", "windows"));
  await open(page, "?one");
  const foot = page.getByRole("navigation", { name: "Media and search" });
  await foot.getByRole("button", { name: "Media" }).click();
  await foot.getByRole("button", { name: "Search" }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_open_tool"))).toEqual([
    `next_open_tool:${JSON.stringify({ which: "media" })}`,
    `next_open_tool:${JSON.stringify({ which: "search" })}`,
  ]);
});

test("a search hit asked for from another window opens beside the list, at that message", async ({ page }) => {
  await open(page, "?one");
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        window.core?.ask("next:intent", { kind: "open", server: "https://good-company.example", roomId: "r-general", conversation: "room", messageId: "m000005" }),
      );
      return page.getByRole("tab", { name: "#general", selected: true }).count();
    })
    .toBe(1);
  // Opened once, around the message.
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("history r-general"))).toEqual(["history r-general?around=m000005&limit=100"]);
  await expect(page.locator('[data-message="m000005"]')).toHaveAttribute("data-flash", "yes");
});

test("a clicked desktop banner opens its conversation at the message; one from a server you've left does nothing (decision 20)", async ({ page }) => {
  await open(page, "?one");
  // Nonsense and a server not signed in are ignored.
  await page.evaluate(() => {
    window.core?.banner({ server: "https://good-company.example", room: 7 });
    window.core?.banner({ server: "https://elsewhere.example", room: "r-general", message: "m000001" });
  });
  await page.waitForTimeout(200);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect
    .poll(async () => {
      await page.evaluate(() => window.core?.banner({ server: "https://good-company.example", room: "r-general", message: "m000005" }));
      return page.getByRole("tab", { name: "#general", selected: true }).count();
    })
    .toBe(1);
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("history r-general"))).toContain("history r-general?around=m000005&limit=100");
  await expect(page.locator('[data-message="m000005"]')).toHaveAttribute("data-flash", "yes");
});

test("a banner clicked with the list in the tray asks the shell to bring it back, so its page is told it's seen again (#594)", async ({ page }) => {
  // In the tray, the list doesn't have the focus.
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await open(page, "?one");
  await expect
    .poll(async () => {
      await page.evaluate(() => window.core?.banner({ server: "https://good-company.example", room: "r-general", message: "m000005" }));
      return page.getByRole("tab", { name: "#general", selected: true }).count();
    })
    .toBe(1);
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("next_show_list")).length).toBeGreaterThan(0);
  // Not the page showing its own window: Windows wouldn't tell its page.
  expect((await did(page)).filter((line) => line === "show")).toEqual([]);
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

test("the tray menu's Mute and Leave, and the tray icon, follow voice, and do what they say while the list is hidden", async ({ page }) => {
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
  // Where, and whether the microphone is live, for the icon and its tooltip (#601).
  const inGeneral = { deafened: false, pushToTalk: false, place: "in #general" };
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: true, muted: false, ...inGeneral })}`);
  await page.evaluate(() => window.core?.tray("mute"));
  await expect(bar.getByRole("button", { name: "Muted" })).toBeVisible();
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: true, muted: true, ...inGeneral })}`);
  await page.evaluate(() => window.core?.tray("leave"));
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await trayLines()).at(-1)).toBe(`next_tray_voice:${JSON.stringify({ inVoice: false, muted: false })}`);
});

test("the first close to the tray says where Linger went, once ever, and that you're in voice (#400)", async ({ page }) => {
  // The desktop lets Linger show banners. The engine's own permission is
  // what the notification plugin asks first, so it's the one granted here.
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted", requestPermission: async () => "granted" } });
  });
  const notices = async () =>
    (await did(page)).filter((line) => line.startsWith("show_notification:")).map((line) => JSON.parse(line.slice("show_notification:".length)) as unknown);
  await open(page, "?one");
  await joinGeneral(page);
  await page.evaluate(() => window.core?.hidden());
  await expect.poll(notices).toEqual([
    { title: "Linger is still running", body: expect.stringMatching(/ Quit Linger from there\. You're still in voice in #general\.$/), open: null },
  ]);
  // Back from the tray and closed again: nothing more.
  await page.evaluate(() => window.core?.hidden());
  await page.waitForTimeout(300);
  expect(await notices()).toHaveLength(1);
  // Nor after Linger starts again, on this computer.
  await open(page, "?one");
  await page.evaluate(() => window.core?.hidden());
  await page.waitForTimeout(300);
  expect(await notices()).toEqual([]);
});

// Coming back to the computer while still away is easy to miss (#392): the
// top card says so, once you're back after a long quiet, and only says so.
test("back at the computer while still away, the top card says so, and nothing sets you back by itself (#392)", async ({ page }) => {
  await page.clock.install();
  await open(page, "?one");
  const you = page.getByRole("region", { name: "You" });
  await you.getByRole("button", { name: "Away" }).click();
  const editor = page.getByRole("dialog", { name: "Away message" });
  await editor.getByRole("button", { name: "asleep 💤", exact: true }).click();
  await editor.getByRole("button", { name: "I'm away" }).click();
  await expect(you).toHaveAttribute("data-away", "yes");
  const nudge = you.getByRole("status");
  await expect(nudge).toHaveCount(0);

  // Using Linger right after going away says nothing.
  await page.mouse.move(100, 300);
  await page.mouse.move(120, 320);
  await expect(nudge).toHaveCount(0);

  // Over ten minutes with nothing, then the mouse moves.
  await page.clock.fastForward("11:00");
  await page.mouse.move(140, 340);
  await expect(nudge).toHaveText("Welcome back. You're still away.");
  await expect(you.getByRole("button", { name: "I'm back" })).toBeVisible();
  await expect(you).toHaveAttribute("data-away", "yes");
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("PATCH")).length).toBe(1);

  // Waved off, it goes, and you stay away.
  await nudge.getByRole("button", { name: "Stay away for now" }).click();
  await expect(nudge).toHaveCount(0);
  await expect(you).toHaveAttribute("data-away", "yes");

  // Back again after another long quiet, it says so again; I'm back takes it away.
  await page.clock.fastForward("11:00");
  await page.mouse.move(160, 360);
  await expect(nudge).toBeVisible();
  await you.getByRole("button", { name: "I'm back" }).click();
  await expect(nudge).toHaveCount(0);
  await expect(you).not.toHaveAttribute("data-away", "yes");
});

// The away picker is a bank you build (#708): six messages, newest first,
// each with a × that takes it out for good, a built-in one too. This device
// keeps it, starting from the recent messages it kept before, and the picker
// reads it each time it opens, with one server or several.
for (const [servers, query] of [
  ["one server", "?one"],
  ["several servers", ""],
] as const) {
  test(`the away picker is a bank you build: × takes one out for good, and a new one goes on top, with ${servers} (#708)`, async ({ page }) => {
    await open(page, query);
    await page.evaluate(() => window.localStorage.setItem("linger.next.recentAway", JSON.stringify(["at the gym"])));
    await open(page, query);
    const you = page.getByRole("region", { name: "You" });
    const editor = page.getByRole("dialog", { name: "Away message" });
    const bank = editor.getByRole("list", { name: "Your away messages" }).locator(".nx-away-choice");
    const box = editor.getByRole("textbox", { name: "Away message" });

    await you.getByRole("button", { name: "Away" }).click();
    await expect(bank).toHaveText(["at the gym", "back after work", "asleep 💤", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"]);
    await expect(box).toHaveValue("at the gym");

    // A built-in one goes, and the keyboard is on the × that took its place.
    await editor.getByRole("button", { name: "Forget “asleep 💤”" }).click();
    await expect(editor.getByRole("button", { name: "Forget “walking the dog 🐕”" })).toBeFocused();
    // One of your own goes too, and that's all a × does: the box keeps what it
    // says, and the picker stays open.
    await editor.getByRole("button", { name: "Forget “at the gym”" }).click();
    await expect(box).toHaveValue("at the gym");
    const kept = ["back after work", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝"];
    await expect(bank).toHaveText(kept);

    // Closed and opened again, they're still gone.
    await editor.getByRole("button", { name: "Cancel" }).click();
    await you.getByRole("button", { name: "Away" }).click();
    await expect(bank).toHaveText(kept);

    // Going away with a new one puts it at the top, and the ones taken out stay out.
    await box.fill("lunch");
    await editor.getByRole("button", { name: "I'm away" }).click();
    await expect(you).toHaveAttribute("data-away", "yes");
    await you.getByRole("button", { name: "I'm back" }).click();
    await expect(you).not.toHaveAttribute("data-away", "yes");
    await you.getByRole("button", { name: "Away" }).click();
    await expect(bank).toHaveText(["lunch", ...kept]);

    // Linger starting again on this device finds the same bank, and the old list is gone.
    await open(page, query);
    await you.getByRole("button", { name: "Away" }).click();
    await expect(bank).toHaveText(["lunch", ...kept]);
    expect(await page.evaluate(() => window.localStorage.getItem("linger.next.recentAway"))).toBeNull();
  });
}

/** Join voice in #general as a chat window would ask, once the connection is up. */
async function joinGeneral(page: Page) {
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
  return bar;
}

/** The arguments of the last time the window told the voice engine `cmd`. */
async function lastCall(page: Page, cmd: string): Promise<Record<string, unknown> | undefined> {
  const line = (await did(page)).filter((one) => one.startsWith(`${cmd}:`)).at(-1);
  return line === undefined ? undefined : (JSON.parse(line.slice(cmd.length + 1)) as Record<string, unknown>);
}

type Controls = { muted: boolean; deafened: boolean };

/** The controls in the last `voice_controls` call: what the engine reports to the room. */
async function reported(page: Page): Promise<Controls | undefined> {
  const controls = (await lastCall(page, "voice_controls"))?.controls;
  if (typeof controls !== "object" || controls === null) return undefined;
  const muted: unknown = Reflect.get(controls, "muted");
  const deafened: unknown = Reflect.get(controls, "deafened");
  return typeof muted === "boolean" && typeof deafened === "boolean" ? { muted, deafened } : undefined;
}

/**
 * Eli's window on #general (tests/fixtures/next-chat-window.tsx, `as=eli`),
 * and a way to hand it the room's voice as the server would pass on what your
 * engine reported: the controls it was last told.
 */
async function elisView(page: Page) {
  const eli = await page.context().newPage();
  await eli.goto("/tests/fixtures/next-chat-window.html?room=r-general&as=eli");
  await expect(eli.getByRole("region", { name: "#general" })).toBeVisible();
  const told = async (controls: Controls | undefined) => {
    if (controls === undefined) throw new Error("nothing was reported");
    await eli.evaluate((mine) => {
      window.owner?.frame({
        op: "voice.state",
        d: {
          room_id: "r-general",
          peers: [
            { session_id: "s-eli", user_id: "u-eli", controls: { muted: false, deafened: false }, forwarded: true },
            { session_id: "s-jules", user_id: "u-jules", controls: { muted: false, deafened: false }, forwarded: true },
            { session_id: "s-good-company.example", user_id: "u-matt", controls: mine, forwarded: true },
          ],
        },
      });
    }, controls);
  };
  const you = eli.getByRole("list", { name: "In voice here" }).getByRole("listitem").filter({ hasText: "Matt" });
  return { told, you };
}

test("somebody talking or you talking moves no chip and no row, and a mute glyph moves no row (VOICE-5)", async ({ page }) => {
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const peers = (eliMuted: boolean) => [
    { session_id: "s-eli", user_id: "u-eli", controls: { muted: eliMuted, deafened: false }, forwarded: true },
    { session_id: "s-jules", user_id: "u-jules", controls: { muted: false, deafened: false }, forwarded: true },
    { session_id: "s-good-company.example", user_id: "u-matt", controls: { muted: false, deafened: false }, forwarded: true },
  ];
  const voiceState = (eliMuted: boolean) =>
    page.evaluate((list) => window.core?.frame("https://good-company.example", { op: "voice.state", d: { room_id: "r-general", peers: list } } as never), peers(eliMuted));
  await voiceState(false);
  const chips = bar.getByRole("list", { name: "Who's in voice" }).locator("[data-kit='Chip']");
  await expect(chips).toHaveCount(3);
  const layout = () =>
    page.evaluate(() => {
      const boxes = (selector: string) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const box = node.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 10) / 10);
        });
      return { chips: boxes("[data-kit='Chip']"), rows: boxes(".nx-list-scroll [data-kit='Row']"), bar: boxes("[role='region'][aria-label^='In voice']") };
    });
  const before = await layout();
  expect(before.rows.length).toBeGreaterThan(4);

  // Eli starts talking: his chip lights, and nothing moves.
  await page.evaluate(() => window.core?.speaking("https://good-company.example", "s-eli", true));
  await expect(chips.filter({ hasText: "Eli" })).toHaveAttribute("data-active", "yes");
  expect(await layout()).toEqual(before);
  // So do you.
  await page.evaluate(() => window.core?.speaking("https://good-company.example", null, true));
  await expect(chips.filter({ hasText: "you" })).toHaveAttribute("data-active", "yes");
  expect(await layout()).toEqual(before);
  // Both stop.
  await page.evaluate(() => window.core?.speaking("https://good-company.example", "s-eli", false));
  await page.evaluate(() => window.core?.speaking("https://good-company.example", null, false));
  await expect(bar.locator("[data-kit='Chip'][data-active='yes']")).toHaveCount(0);
  expect(await layout()).toEqual(before);
  // Eli mutes: the glyph shows on his chip, which grows to hold it, and the
  // bar and the list under it stay where they were.
  await voiceState(true);
  await expect(chips.filter({ hasText: "Eli" }).locator(".k-chip-state")).toBeVisible();
  const muted = await layout();
  expect({ rows: muted.rows, bar: muted.bar }).toEqual({ rows: before.rows, bar: before.bar });
});

test("with push-to-talk on, the list losing focus closes the microphone, even with the key still down", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await open(page, "?one");
  await joinGeneral(page);
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: true });
  await page.keyboard.down("ControlRight");
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: false });
  // Alt+Tab away with the key still down: the list never hears it come up.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: true });
  await page.keyboard.up("ControlRight");
});

test("with push-to-talk on, the talk key heard with a game in front talks just as the key in the list does, muted and deafened included (#500)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const closed = async () => (await lastCall(page, "voice_push_to_talk"))?.closed;
  const gates = async () => (await did(page)).filter((line) => line.startsWith("voice_push_to_talk:")).length;
  const shell = (edge: "down" | "up") => page.evaluate((heard) => window.core?.talkKey(heard), edge);
  // In voice with push-to-talk on, the shell is asked to watch for the chosen key.
  await expect.poll(() => lastCall(page, "voice_talk_key")).toEqual({ key: "ControlRight" });
  await expect.poll(closed).toBe(true);

  // Heard by the shell: opens and closes the microphone as the key here does, with no mute.
  await shell("down");
  await expect.poll(closed).toBe(false);
  await expect(bar.getByRole("status")).toHaveCount(0);
  await shell("up");
  await expect.poll(closed).toBe(true);
  await expect(bar.getByRole("status")).toHaveText("hold Right Ctrl to talk");
  expect(await reported(page)).toEqual({ muted: false, deafened: false });

  // Heard here and by the shell at once: opened once, closed once.
  const once = await gates();
  await page.keyboard.down("ControlRight");
  await shell("down");
  await expect.poll(closed).toBe(false);
  await shell("up");
  await page.keyboard.up("ControlRight");
  await expect.poll(closed).toBe(true);
  await page.waitForTimeout(100);
  expect(await gates()).toBe(once + 2);

  // Alt+Tab to the game with the key down: the shell still hears it held, so you keep talking.
  await page.keyboard.down("ControlRight");
  await shell("down");
  await expect.poll(closed).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(100);
  expect(await closed()).toBe(false);
  await shell("up");
  await expect.poll(closed).toBe(true);
  await page.keyboard.up("ControlRight");

  // Muted: the room is never told otherwise, as with the key here.
  await bar.getByRole("button", { name: "Mute", exact: true }).click();
  await expect.poll(() => reported(page)).toEqual({ muted: true, deafened: false });
  await shell("down");
  await page.waitForTimeout(100);
  expect(await reported(page)).toEqual({ muted: true, deafened: false });
  await expect(bar.getByRole("button", { name: "Muted", exact: true })).toHaveAttribute("aria-pressed", "true");
  await shell("up");
  await bar.getByRole("button", { name: "Muted", exact: true }).click();
  await expect.poll(() => reported(page)).toEqual({ muted: false, deafened: false });
  await expect.poll(closed).toBe(true);

  // Deafened: the key opens nothing.
  await bar.getByRole("button", { name: "Deafen", exact: true }).click();
  await expect.poll(() => reported(page)).toEqual({ muted: true, deafened: true });
  const deaf = await gates();
  await shell("down");
  await page.waitForTimeout(100);
  expect(await gates()).toBe(deaf);
  await shell("up");

  // Leaving voice stops the shell watching.
  await bar.getByRole("button", { name: "Leave voice", exact: true }).click();
  await expect.poll(() => lastCall(page, "voice_talk_key")).toEqual({ key: null });
});

test("the shell watches for the talk key only in voice with push-to-talk on, and for the key Settings picks (#500)", async ({ page }) => {
  await open(page, "?one");
  // Not in voice: never asked to watch.
  await page.waitForTimeout(200);
  expect((await did(page)).filter((line) => line.startsWith("voice_talk_key:")).every((line) => line === 'voice_talk_key:{"key":null}')).toBe(true);
  // In voice without push-to-talk: still not.
  const bar = await joinGeneral(page);
  await page.waitForTimeout(200);
  expect(await lastCall(page, "voice_talk_key")).toEqual({ key: null });
  // Push-to-talk turned on in Settings, then another key picked: watched, then for that key.
  const pushToTalk = (on: boolean, key: string) => page.evaluate(({ on, key }) => window.core?.ask("next:intent", { kind: "voice.pushtotalk", on, key }), { on, key });
  await page.evaluate(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await pushToTalk(true, "ControlRight");
  await expect.poll(() => lastCall(page, "voice_talk_key")).toEqual({ key: "ControlRight" });
  await page.evaluate(() => localStorage.setItem("linger.voice.pushToTalkKey", "MouseBack"));
  await pushToTalk(true, "MouseBack");
  await expect.poll(() => lastCall(page, "voice_talk_key")).toEqual({ key: "MouseBack" });
  await expect(bar.getByRole("status")).toHaveText("hold Mouse 4 to talk");
  // Off again: it stops.
  await pushToTalk(false, "MouseBack");
  await expect.poll(() => lastCall(page, "voice_talk_key")).toEqual({ key: null });
});

test("push-to-talk with the key up shows no mute, to you or to anyone else; a mute you choose shows to both (#232)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const yours = bar.getByRole("listitem").filter({ hasText: "you" });

  // Your view: how to talk, and no mute anywhere, the tray menu included.
  await expect(bar.getByRole("status")).toHaveText("hold Right Ctrl to talk");
  await expect(yours.locator(".k-chip-state")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute("aria-pressed", "false");
  // The tray icon shows you in voice with push-to-talk, held key or not (#601).
  const trayNow = async () => (await did(page)).filter((line) => line.startsWith("next_tray_voice")).at(-1);
  const trayPushToTalk = `next_tray_voice:${JSON.stringify({ inVoice: true, muted: false, deafened: false, pushToTalk: true, place: "in #general" })}`;
  await expect.poll(trayNow).toBe(trayPushToTalk);
  // The microphone is closed by the key's own gate; the room is told it's on.
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: true });
  expect(await reported(page)).toEqual({ muted: false, deafened: false });

  // Holding the key opens it and letting go closes it, still without a mute.
  await page.keyboard.down("ControlRight");
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: false });
  expect(await trayNow(), "the tray doesn't flicker with the key").toBe(trayPushToTalk);
  await expect(bar.getByRole("status")).toHaveCount(0);
  await page.keyboard.up("ControlRight");
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: true });
  await expect(yours.locator(".k-chip-state")).toHaveCount(0);
  expect(await reported(page)).toEqual({ muted: false, deafened: false });

  // Eli's view of you, from what the room was told: no mute.
  const eli = await elisView(page);
  await eli.told(await reported(page));
  await expect(eli.you).toBeVisible();
  await expect(eli.you.locator(".k-chip-state")).toHaveCount(0);

  // Without push-to-talk, Mute pressed: the glyph shows, for you and for Eli, as before.
  await bar.getByRole("button", { name: "Leave voice", exact: true }).click();
  await expect(bar).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("linger.voice.pushToTalk", "false"));
  await joinGeneral(page);
  await expect(bar.getByRole("status")).toHaveCount(0);
  await bar.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(yours.locator(".k-chip-state")).toHaveText("Muted");
  await expect.poll(() => reported(page)).toEqual({ muted: true, deafened: false });
  await eli.told(await reported(page));
  await expect(eli.you.locator(".k-chip-state")).toHaveText("Muted");
});

test("Settings turning push-to-talk off and on, or picking its key, applies to the call you're in at once (#231)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const yours = bar.getByRole("listitem").filter({ hasText: "you" });
  const line = bar.getByRole("status");
  const closed = async () => (await lastCall(page, "voice_push_to_talk"))?.closed;
  const joins = async () => (await did(page)).filter((one) => one.startsWith("voice_join")).length;
  const pushToTalk = (on: boolean, key = "ControlRight") => page.evaluate(({ on, key }) => window.core?.ask("next:intent", { kind: "voice.pushtotalk", on, key }), { on, key });
  await expect(line).toHaveText("hold Right Ctrl to talk");
  await expect.poll(closed).toBe(true);
  // `joinGeneral` asks again until the bar shows, so a slow engine may have
  // been asked twice; what matters is that nothing below joins again.
  const joined = await joins();

  // Off: the microphone opens, without leaving and joining again.
  await pushToTalk(false);
  await expect.poll(closed).toBe(false);
  await expect(line).toHaveCount(0);
  await expect(yours.locator(".k-chip-state")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute("aria-pressed", "false");
  // The key does nothing now.
  await page.keyboard.down("ControlRight");
  await page.keyboard.up("ControlRight");
  expect(await closed()).toBe(false);

  // On again: closed until the key is held.
  await pushToTalk(true);
  await expect.poll(closed).toBe(true);
  await expect(line).toHaveText("hold Right Ctrl to talk");
  await page.keyboard.down("ControlRight");
  await expect.poll(closed).toBe(false);
  await page.keyboard.up("ControlRight");
  await expect.poll(closed).toBe(true);

  // A new key: the bar names it, and it's the one that talks.
  await page.evaluate(() => localStorage.setItem("linger.voice.pushToTalkKey", "AltRight"));
  await pushToTalk(true, "AltRight");
  await expect(line).toHaveText("hold Right Alt to talk");
  await page.keyboard.down("ControlRight");
  await page.keyboard.up("ControlRight");
  expect(await closed()).toBe(true);
  await page.keyboard.down("AltRight");
  await expect.poll(closed).toBe(false);
  await page.keyboard.up("AltRight");
  await expect.poll(closed).toBe(true);

  // A mute you chose survives turning push-to-talk off: you stay muted, and so does the tray.
  await bar.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(yours.locator(".k-chip-state")).toHaveText("Muted");
  await pushToTalk(false, "AltRight");
  await expect.poll(closed).toBe(false);
  await expect(bar.getByRole("button", { name: "Muted", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(yours.locator(".k-chip-state")).toHaveText("Muted");
  await expect(line).toHaveCount(0);
  expect(await reported(page)).toEqual({ muted: true, deafened: false });
  await expect.poll(async () => (await did(page)).filter((one) => one.startsWith("next_tray_voice")).at(-1)).toBe(
    `next_tray_voice:${JSON.stringify({ inVoice: true, muted: true, deafened: false, pushToTalk: false, place: "in #general" })}`,
  );
  // All in the one call.
  expect(await joins()).toBe(joined);
});

test("a Mute pressed in a chat window is answered with its sound for that window to play, and makes none here; the voice bar and the tray still sound here (#241)", async ({ page }) => {
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const sounds = async () => (await did(page)).filter((line) => line.startsWith("sound:")).map((line) => line.slice("sound:".length));
  // A key here opens this window's audio, as any key or click does, so
  // silence below is this window choosing not to play.
  await page.keyboard.press("Shift");

  await page.evaluate(() => window.core?.ask("next:voicecontrol", { control: "mute", on: true }));
  await expect(bar.getByRole("button", { name: "Muted", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await did(page)).filter((line) => line.startsWith("to chat:next:voicecontrol:answer:")))
    .toEqual([`to chat:next:voicecontrol:answer:${JSON.stringify({ v: 1, id: "q-1", from: "main", answer: { cue: "mute" } })}`]);

  // The voice bar's own Unmute, and the tray's Mute, sound here as before.
  await bar.getByRole("button", { name: "Muted", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await expect.poll(sounds).toEqual(["unmute"]);
  // Past the player's guard against a burst: one sound of a kind per 100 ms.
  await page.waitForTimeout(150);
  await page.evaluate(() => window.core?.tray("mute"));
  await expect(bar.getByRole("button", { name: "Muted", exact: true })).toBeVisible();
  await expect.poll(sounds).toEqual(["unmute", "mute"]);
});

test("with push-to-talk, the key makes no sound, and a Mute you choose does, as a real mute (#232, #241)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linger.voice.pushToTalk", "true"));
  await open(page, "?one");
  const bar = await joinGeneral(page);
  const sounds = async () => (await did(page)).filter((line) => line.startsWith("sound:")).map((line) => line.slice("sound:".length));
  // A key here opens this window's audio, so silence below is a choice.
  await page.keyboard.press("Shift");

  await page.keyboard.down("ControlRight");
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: false });
  await page.keyboard.up("ControlRight");
  await expect.poll(() => lastCall(page, "voice_push_to_talk")).toMatchObject({ closed: true });
  await page.waitForTimeout(150);
  expect(await sounds()).toEqual([]);

  await bar.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Muted", exact: true })).toBeVisible();
  await expect.poll(sounds).toEqual(["mute"]);
});

// Who shares and who watches comes in the room's `voice.state` (PROTOCOL §8),
// to this window, which holds the connection and plays the chimes, wherever
// the share itself runs.
test("somebody starting to watch your screen plays its chime here; watching somebody else's, nothing does (#735)", async ({ page }) => {
  await open(page, "?one");
  await joinGeneral(page);
  const sounds = async () => (await did(page)).filter((line) => line.startsWith("sound:")).map((line) => line.slice("sound:".length));
  // A key here opens this window's audio, so silence below is a choice.
  await page.keyboard.press("Shift");
  const voice = (peers: object[]) =>
    page.evaluate((peers) => window.core?.frame("https://good-company.example", { op: "voice.state", d: { room_id: "r-general", peers } } as never), peers);
  const me = { session_id: "s-good-company.example", user_id: "u-matt", forwarded: true };
  const eli = { session_id: "s-eli", user_id: "u-eli" };
  const jules = { session_id: "s-jules", user_id: "u-jules" };
  const dave = { session_id: "s-dave", user_id: "u-dave" };

  // Watching Jules's screen: you starting, and Eli starting after you, play
  // nothing. Jules's share starting plays its own chords (#746).
  await voice([me, eli, jules]);
  await expect.poll(sounds).toEqual(["voice-join"]);
  // Past the player's guard against a burst: one voice sound per 100 ms.
  await page.waitForTimeout(150);
  await voice([{ ...me, watching: "s-jules" }, eli, { ...jules, screen: { fps: 60 } }]);
  await voice([{ ...me, watching: "s-jules" }, { ...eli, watching: "s-jules" }, { ...jules, screen: { fps: 60 } }]);
  await expect.poll(sounds).toEqual(["voice-join", "share"]);
  // Dave joining voice does sound, so the silence before it was this window choosing.
  await voice([{ ...me, watching: "s-jules" }, { ...eli, watching: "s-jules" }, { ...jules, screen: { fps: 60 } }, dave]);
  await expect.poll(sounds).toEqual(["voice-join", "share", "peer-join"]);
  await page.waitForTimeout(300);
  expect(await sounds()).toEqual(["voice-join", "share", "peer-join"]);

  // Sharing your own: it starting plays the share's chords for you too
  // (#746), and Eli starting to watch it plays the chime, once.
  const sharing = { ...me, screen: { fps: 60 } };
  await voice([sharing, eli, jules, dave]);
  await expect.poll(sounds).toEqual(["voice-join", "share", "peer-join", "share"]);
  await voice([sharing, { ...eli, watching: me.session_id }, jules, dave]);
  await expect.poll(sounds).toEqual(["voice-join", "share", "peer-join", "share", "watcher"]);
  await voice([sharing, { ...eli, watching: me.session_id }, jules, dave]);
  await page.waitForTimeout(300);
  expect(await sounds()).toEqual(["voice-join", "share", "peer-join", "share", "watcher"]);
});

// Matt, #746: in a room of seven, somebody started sharing and most of the
// room didn't notice. Everybody in that voice hears it start, and the voice
// bar offers Watch whatever room is open.
test("a share starting in your voice plays its chords here, the voice bar offers Watch, and Watch opens the room watching it (#746)", async ({ page }) => {
  await open(page, "?one&screens");
  const bar = await joinGeneral(page);
  const sounds = async () => (await did(page)).filter((line) => line.startsWith("sound:")).map((line) => line.slice("sound:".length));
  // A key here opens this window's audio, so silence below is a choice.
  await page.keyboard.press("Shift");
  const voice = (peers: object[]) =>
    page.evaluate((peers) => window.core?.frame("https://good-company.example", { op: "voice.state", d: { room_id: "r-general", peers } } as never), peers);
  const me = { session_id: "s-good-company.example", user_id: "u-matt", forwarded: true };
  const eli = { session_id: "s-eli", user_id: "u-eli" };
  const jules = { session_id: "s-jules", user_id: "u-jules" };
  const julesSharing = { ...jules, screen: { fps: 30 } };

  await voice([me, eli, jules]);
  await expect.poll(sounds).toEqual(["voice-join"]);
  await voice([me, eli, julesSharing]);
  await expect.poll(sounds).toEqual(["voice-join", "share"]);
  const shares = bar.getByRole("list", { name: "Screens shared here" });
  await expect(shares).toHaveText(/Jules is sharing their screen/);
  await expect(shares.getByRole("button", { name: "Watch" })).toHaveAttribute("data-variant", "primary");
  // Stopping steps the chords down. Sharing again a moment later is quiet:
  // the start, like the stop, sounds once a minute for each person, as
  // joining and leaving voice do.
  await page.waitForTimeout(150);
  await voice([me, eli, jules]);
  await expect(shares).toHaveCount(0);
  await expect.poll(sounds).toEqual(["voice-join", "share", "share-stop"]);
  await voice([me, eli, julesSharing]);
  await page.waitForTimeout(300);
  expect(await sounds()).toEqual(["voice-join", "share", "share-stop"]);

  // Eli sharing too: a line each, each Watch named for whose it is.
  await voice([me, { ...eli, screen: { fps: 60 } }, julesSharing]);
  await expect(shares.getByRole("listitem")).toHaveCount(2);
  await expect(shares.getByRole("button", { name: "Watch Eli" })).toBeVisible();

  // Watch: #general opens beside the list, and Jules's screen with it.
  await page.setViewportSize({ width: 1120, height: 820 });
  await shares.getByRole("button", { name: "Watch Jules" }).click();
  await expect(page.getByRole("region", { name: "Jules's screen" })).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/general/);
});

// Join and Leave redraw the strip's buttons under the pointer: Deafen where
// Join was, Join where Leave was. A double-click's second click was meant
// for the button that was there, and does nothing (#510).
test("a double-click on the strip's Join joins once, neither muted nor deafened; one on Leave leaves without joining again (#510)", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page, "?one");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  const yours = strip.getByRole("group", { name: "Your voice" });
  const joins = async () => (await did(page)).filter((line) => line.startsWith("voice_join:"));
  // Every set of controls the voice engine was told, in order.
  const told = async () =>
    (await did(page)).filter((line) => line.startsWith("voice_controls:")).map((line) => (JSON.parse(line.slice("voice_controls:".length)) as { controls: unknown }).controls);

  await strip.getByRole("button", { name: "Join", exact: true }).dblclick();
  await expect(yours).toBeVisible();
  // Well past anything the second click could have set off.
  await page.waitForTimeout(500);
  expect(await joins()).toHaveLength(1);
  await expect(yours.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(yours.getByRole("button", { name: "Deafen", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await told()).toEqual([{ muted: false, deafened: false }]);

  // A click a moment later is a click again.
  await yours.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(yours.getByRole("button", { name: "Muted", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(told).toEqual([
    { muted: false, deafened: false },
    { muted: true, deafened: false },
  ]);

  await page.waitForTimeout(500);
  await yours.getByRole("button", { name: "Leave voice", exact: true }).dblclick();
  await expect(strip.getByRole("button", { name: "Join", exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(yours).toHaveCount(0);
  expect(await joins()).toHaveLength(1);
});

// #747: the strip beside the list is in the window that runs voice, so a
// volume set from one of its chips is played at once, kept as the voice bar's
// is, and shown there too.
test("a volume set from the strip beside the list is played at once, and the voice bar shows it too (#747)", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 820 });
  await open(page, "?one");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  const strip = page.getByRole("group", { name: "Voice in this conversation" });
  await strip.getByRole("button", { name: "Join", exact: true }).click();
  await expect(strip.getByRole("group", { name: "Your voice" })).toBeVisible();
  await strip.getByRole("button", { name: "Eli's volume, 100%" }).click();
  await expect(page.getByRole("dialog", { name: "Eli's volume" }).getByRole("slider")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  // Joining plays everybody at their saved level first, 100% here; then the two steps.
  const played = async () =>
    (await did(page))
      .filter((line) => line.startsWith("voice_volume:"))
      .map((line) => JSON.parse(line.slice("voice_volume:".length)) as Record<string, unknown>)
      .filter((call) => call.volume !== 1);
  await expect.poll(played).toEqual([
    { baseUrl: "https://good-company.example", peer: "s-eli", volume: 0.95 },
    { baseUrl: "https://good-company.example", peer: "s-eli", volume: 0.9 },
  ]);
  await expect(strip.getByRole("button", { name: "Eli's volume, 90%" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^In voice in #general/ }).getByRole("button", { name: "Eli's volume, 90%" })).toBeVisible();
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

// Linger updates itself (#772): the foot says so, the tray offers it, and
// nothing restarts in voice or while you share a screen.
const updates = (page: Page) => page.locator("[data-screen='list-notes'] .nx-update");
const trayUpdate = async (page: Page) => (await did(page)).filter((line) => line.startsWith("next_tray_voice")).at(-1) ?? "";

test("a downloaded update is a calm line that says when it installs, and Restart now installs it (#772)", async ({ page }) => {
  await open(page, "?one&update");
  const ready = updates(page);
  await expect(ready).toHaveCount(1);
  await expect(ready).toHaveAttribute("data-note", "update");
  // Calm: there's nothing anybody has to do, so it isn't in the lamp.
  await expect(ready).not.toHaveAttribute("data-lit", "yes");
  await expect(ready).toContainText("Linger 0.4.1 is ready");
  await expect(ready).toContainText("It installs the next time Linger starts, or while you're away from your computer.");
  await expect(ready.getByRole("button", { name: "What's new" })).toHaveCount(0);
  // The tray offers it too, and its tooltip says so.
  await expect.poll(() => trayUpdate(page)).toContain(JSON.stringify({ update: { text: "Restart to update Linger", tip: "0.4.1 is ready" } }).slice(1, -1));
  await ready.getByRole("button", { name: "Restart now" }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
});

test("the tray's Restart to update Linger installs it too (#772)", async ({ page }) => {
  await open(page, "?one&update");
  await expect(updates(page)).toHaveCount(1);
  await page.evaluate(() => window.core?.tray("update"));
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
});

test("nothing restarts in voice: Restart now waits, and Settings' press is done once you've left (#772)", async ({ page }) => {
  await open(page, "?one&update");
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
  const restart = updates(page).getByRole("button", { name: "Restart now" });
  await expect(restart).toHaveAttribute("aria-disabled", "true");
  await restart.click({ force: true });
  await page.evaluate(() => window.core?.tray("update"));
  // Settings can't see voice: its Restart now waits for you to leave.
  await page.evaluate(() => window.core?.ask("next:intent", { kind: "update" }));
  await page.waitForTimeout(300);
  expect((await did(page)).filter((line) => line.startsWith("update_now"))).toEqual([]);
  await page.evaluate(() => window.core?.tray("leave"));
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
});

test("an update on its day's wait says nothing until it's downloaded (#772)", async ({ page }) => {
  await open(page, "?one&update=waiting");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
  expect(await trayUpdate(page)).not.toContain("update");
  await page.evaluate(() => window.core?.downloaded());
  await expect(updates(page)).toContainText("Linger 0.4.1 is ready");
});

test("a copy that needs a password is asked, in the lamp, and can put it off until tomorrow (#772)", async ({ page }) => {
  await open(page, "?one&update=password");
  const out = updates(page);
  await expect(out).toHaveAttribute("data-lit", "yes");
  await expect(out).toContainText("Linger 0.4.1 is out");
  await expect(out).toContainText("Screen sharing, and fixes for voice.");
  await expect(out.getByRole("button", { name: "Restart now" })).toHaveCount(0);
  await expect.poll(() => trayUpdate(page)).toContain(JSON.stringify({ update: { text: "Update Linger", tip: "0.4.1 is out" } }).slice(1, -1));
  await out.getByRole("button", { name: "What's new" }).click();
  expect(await did(page)).toContain("open https://github.com/itsMattGuenther/Linger/releases/tag/v0.4.1");
  await out.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
});

test("Not now puts an \"is out\" line off until tomorrow, on this computer (#772)", async ({ page }) => {
  await open(page, "?one&update=password");
  await updates(page).getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-screen='list']")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
});

test("an Arch copy is told it's out, with nothing to install and nothing in the tray (#772)", async ({ page }) => {
  await open(page, "?one&update=arch");
  const out = updates(page);
  await expect(out).toHaveAttribute("data-lit", "yes");
  await expect(out).toContainText("Linger 0.4.1 is out");
  await expect(out).toContainText("It comes with your next system update.");
  await expect(out).not.toContainText("Omarchy");
  await expect(out.getByRole("button", { name: /^(Update|Restart now)$/ })).toHaveCount(0);
  await expect(out.getByRole("button", { name: "What's new" })).toBeVisible();
  expect(await trayUpdate(page)).not.toContain("update");
});

test("the first start after an update says so once, in the lamp, with what's in it (#772)", async ({ page }) => {
  await open(page, "?one&updated");
  const updated = updates(page);
  await expect(updated).toHaveAttribute("data-note", "updated");
  await expect(updated).toHaveAttribute("data-lit", "yes");
  await expect(updated).toContainText(/^You're on Linger \d+\.\d+\.\d+/);
  await updated.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
});

test("an update kept for this start goes in before the list, which starts as it is if it can't (#772)", async ({ page }) => {
  await page.goto("/tests/fixtures/next-list-window.html?one&pending");
  await expect(page.getByRole("status")).toContainText("Updating to Linger 0.4.1…");
  await expect(page.getByRole("status")).toContainText("Back in a few seconds.");
  expect(await did(page)).toContain("update_install_pending");
  // Nothing connects while it's installing.
  expect((await did(page)).filter((line) => line.startsWith("connect "))).toEqual([]);
  await page.evaluate(() => window.core?.installFailed());
  await expect(page.locator("[data-screen='list']")).toBeVisible();
});

test("why an update didn't happen is said on its line (#772)", async ({ page }) => {
  await open(page, "?one&update&updatefail");
  await updates(page).getByRole("button", { name: "Restart now" }).click();
  await expect(updates(page).getByRole("alert")).toHaveText("Couldn't update: The network is down.");
});

test("left for half an hour, Linger restarts by itself to install it, without taking the focus (#772)", async ({ page }) => {
  await page.clock.install();
  await open(page, "?one&update");
  await expect(updates(page)).toHaveCount(1);
  await page.clock.runFor(29 * 60 * 1000);
  expect((await did(page)).filter((line) => line.startsWith("update_now"))).toEqual([]);
  await page.clock.runFor(2 * 60 * 1000);
  await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now behind automatic"]);
});

/** Into voice in #general, from another window, as the volume tests do. */
async function joinVoice(page: Page) {
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
  return bar;
}

const installs = async (page: Page) => (await did(page)).filter((line) => line.startsWith("update_now"));

test("the shell's last check finds you in voice: it waits, and goes in once you've left (#794 review)", async ({ page }) => {
  await open(page, "?one&update&updatebusy");
  // The list thought nobody was in voice, but somebody joined while it fetched.
  await updates(page).getByRole("button", { name: "Restart now" }).click();
  await expect.poll(() => installs(page)).toEqual(["update_now shown"]);
  const bar = await joinVoice(page);
  await page.evaluate(() => window.core?.answerBusy());
  await page.waitForTimeout(300);
  expect(await installs(page)).toEqual(["update_now shown"]);
  await page.evaluate(() => window.core?.tray("leave"));
  await expect(bar).toHaveCount(0);
  await expect.poll(() => installs(page)).toEqual(["update_now shown", "update_now shown"]);
});

test("a busy answer that arrives after you've left voice still goes in (#794 review)", async ({ page }) => {
  await open(page, "?one&update&updatebusy");
  await updates(page).getByRole("button", { name: "Restart now" }).click();
  await expect.poll(() => installs(page)).toEqual(["update_now shown"]);
  const bar = await joinVoice(page);
  await page.evaluate(() => window.core?.tray("leave"));
  await expect(bar).toHaveCount(0);
  // Left already when the shell's answer comes back.
  await page.evaluate(() => window.core?.answerBusy());
  await expect.poll(() => installs(page)).toEqual(["update_now shown", "update_now shown"]);
});

// A server that needs a newer app (#793): Linger doesn't connect to it, its
// row is dimmed, and the foot says so, with Update now on a copy that
// installs itself. This copy is 0.3.6; `?tooold` has Casa da Ribeira work
// with 0.5.4 or newer.
const tooOld = (page: Page) => page.locator("[data-screen='list-notes'] .nx-update[data-note='tooold']");
const CASA_AT = "casa-da-ribeira.example";

test.describe("a server that needs a newer app (#793)", () => {
  test("isn't connected to or signed in to, its sign-in kept; its row is dimmed, the foot says so with Update now, and the others work", async ({ page }) => {
    await open(page, "?tooold");
    // Named by its address: it hasn't said its name this launch.
    const casa = section(page, CASA_AT);
    await expect(casa).toHaveAttribute("data-blocked", "yes");
    await expect(casa).toContainText("needs a newer Linger");
    await expect(casa.locator(".nx-srv-dots")).toHaveCount(0);
    await expect(casa.getByRole("button")).toHaveCount(0);
    // Its name in the muted ink.
    const muted = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-muted)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(casa.locator(".nx-srv-name")).toHaveCSS("color", muted);
    // The others are there and working, before it in your order.
    await expect(section(page, "The Good Company")).toBeVisible();
    await expect(section(page, "Ashen Lanterns")).toBeVisible();
    await expect.poll(async () => page.locator(".nx-srv").evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label")))).toEqual([
      "The Good Company",
      "Ashen Lanterns",
      CASA_AT,
    ]);
    const asked = await did(page);
    expect(asked).toContain(`GET ${LISBON}/health`);
    // Asked before anything else, and nothing after: no sign-in, no connection, and its sign-in left as it was.
    expect(asked.filter((line) => line.includes(LISBON))).toEqual([`GET ${LISBON}/health`]);
    for (const server of [HOME, GUILD]) expect(asked).toContain(`connect ${server}`);

    const block = tooOld(page);
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-lit", "yes");
    await expect(block.locator(".nx-update-title")).toHaveText(`${CASA_AT} needs a newer Linger`);
    await expect(block).toContainText("It works with Linger 0.5.4 or newer. Your other servers still work.");
    // Nothing to put off: it can't be used until Linger's updated.
    await expect(block.getByRole("button", { name: /Not now|Close/ })).toHaveCount(0);
    // Update now doesn't wait out the day: the shell is asked now.
    await block.getByRole("button", { name: "Update now" }).click();
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
  });

  test("a server updated before it was ever reached says so on the next failed try, not \"Can't reach\" forever (#797 review)", async ({ page }) => {
    // Not `open`: that waits for every server to be up, and this one never is.
    await page.goto("/tests/fixtures/next-list-window.html?neverup");
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await expect(section(page, "The Good Company")).toBeVisible();
    // Signed in fine, but its gateway takes nothing: it was updated in between.
    await page.evaluate((server) => window.core?.raise(server), LISBON);
    // The next try, and its failure, as the gateway reports a retry.
    await page.evaluate((server) => window.core?.status(server, { kind: "connecting" }), LISBON);
    await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 1000, reason: "the server closed the connection" }), LISBON);
    await expect(tooOld(page).locator(".nx-update-title")).toContainText("needs a newer Linger");
  });

  test("a server updated while Linger runs is let go of when it comes back, by name, its sign-in kept, the others untouched", async ({ page }) => {
    await open(page);
    await expect(section(page, "Casa da Ribeira")).toBeVisible();
    await expect(tooOld(page)).toHaveCount(0);
    // Its host updates it: it restarts, and says so once it's back.
    await page.evaluate((server) => window.core?.raise(server), LISBON);
    await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 1000, reason: "connection refused" }), LISBON);
    await page.evaluate((server) => window.core?.status(server, { kind: "ready", latency_ms: 20 }), LISBON);
    const casa = section(page, "Casa da Ribeira");
    await expect(casa).toHaveAttribute("data-blocked", "yes");
    await expect(tooOld(page).locator(".nx-update-title")).toHaveText("Casa da Ribeira needs a newer Linger");
    await expect(tooOld(page)).toContainText("Your other servers still work.");
    const asked = await did(page);
    expect(asked.filter((line) => line === `connect ${LISBON}` || line === `disconnect ${LISBON}`).at(-1)).toBe(`disconnect ${LISBON}`);
    // Every window lets go of it; nothing signs out of it.
    expect(asked).toContain(`emit next:signedout:${JSON.stringify({ v: 1, server: LISBON })}`);
    expect(asked).not.toContain(`forget ${LISBON}`);
    expect(asked.filter((line) => line.startsWith("POST") && line.includes(LISBON) && line.endsWith("/auth/logout"))).toEqual([]);
    for (const server of [HOME, GUILD]) {
      expect(asked.filter((line) => line === `connect ${server}` || line === `disconnect ${server}`).at(-1)).toBe(`connect ${server}`);
    }
  });

  test("a server that comes back and works with this app stays as it was", async ({ page }) => {
    await open(page);
    await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 1000, reason: "connection refused" }), LISBON);
    await page.evaluate((server) => window.core?.status(server, { kind: "ready", latency_ms: 20 }), LISBON);
    await expect.poll(async () => (await did(page)).filter((line) => line === `GET ${LISBON}/health`).length).toBeGreaterThan(1);
    await page.waitForTimeout(200);
    await expect(section(page, "Casa da Ribeira")).not.toHaveAttribute("data-blocked", "yes");
    await expect(tooOld(page)).toHaveCount(0);
    const asked = await did(page);
    expect(asked.filter((line) => line === `connect ${LISBON}` || line === `disconnect ${LISBON}`).at(-1)).toBe(`connect ${LISBON}`);
  });

  test("the only server: the list, not the sign-in, with no word about other servers", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list-window.html?one&tooold=all");
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await expect(page.locator("[data-screen='signin']")).toHaveCount(0);
    await expect(section(page, "good-company.example")).toHaveAttribute("data-blocked", "yes");
    const block = tooOld(page);
    await expect(block.locator(".nx-update-title")).toHaveText("good-company.example needs a newer Linger");
    await expect(block.locator(".nx-update-line").first()).toHaveText("It works with Linger 0.5.4 or newer.");
    await expect(block.getByRole("button", { name: "Update now" })).toBeVisible();
    expect((await did(page)).filter((line) => line.startsWith("connect ") || line.includes("/auth/"))).toEqual([]);
  });

  test("several in one block, naming each", async ({ page }) => {
    await page.goto("/tests/fixtures/next-list-window.html?tooold=all");
    await expect(page.locator("[data-screen='list']")).toBeVisible();
    await expect(tooOld(page)).toHaveCount(1);
    await expect(tooOld(page).locator(".nx-update-title")).toHaveText(
      "good-company.example, ashen-lanterns.example and casa-da-ribeira.example need a newer Linger",
    );
    await expect(tooOld(page)).toContainText("They work with Linger 0.5.4 or newer.");
    await expect(tooOld(page)).not.toContainText("Your other servers still work.");
  });

  test("in voice, Update now can't be pressed and says why, and can be once you've left", async ({ page }) => {
    await open(page, "?tooold");
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
    const update = tooOld(page).getByRole("button", { name: "Update now" });
    await expect(update).toHaveAttribute("aria-disabled", "true");
    await expect(update).toHaveAccessibleDescription("Not while you're in voice.");
    await update.click({ force: true });
    await page.waitForTimeout(300);
    expect((await did(page)).filter((line) => line.startsWith("update_now"))).toEqual([]);
    await page.evaluate(() => window.core?.tray("leave"));
    await expect(bar).toHaveCount(0);
    await expect(update).not.toHaveAttribute("aria-disabled", "true");
    await update.click();
    await expect.poll(async () => (await did(page)).filter((line) => line.startsWith("update_now"))).toEqual(["update_now shown"]);
  });

  test("an Arch copy gets the words and how the new one comes, with no button and no second notice", async ({ page }) => {
    await open(page, "?tooold&update=arch");
    const block = tooOld(page);
    await expect(block).toContainText("It comes with your next system update (sudo pacman -Syu).");
    await expect(block.getByRole("button")).toHaveCount(0);
    // The "is out" line would say the same thing again, less urgently.
    await expect(page.locator("[data-screen='list-notes'] .nx-update")).toHaveCount(1);
  });

  test("adding it says so before asking for a password", async ({ page }) => {
    await open(page, "?one&tooold");
    await page.evaluate(() => window.core?.ask("next:intent", { kind: "addserver" }));
    const box = page.getByRole("textbox", { name: "Server or link" });
    await box.fill(`${LISBON}/invite/RIBEIRA`);
    await box.press("Enter");
    await expect(page.getByText("This server needs a newer Linger. It works with Linger 0.5.4 or newer. Update Linger, then try again.")).toBeVisible();
    await expect(page.getByRole("form", { name: "Join" })).toHaveCount(0);
    expect((await did(page)).filter((line) => line.includes(LISBON))).toEqual([`GET ${LISBON}/health`]);
  });
});

test.describe("a server that needs a newer app, on a phone (#793)", () => {
  test.use({ viewport: { width: 411, height: 914 } });

  test("points an Android phone at Google Play, with no button", async ({ page }) => {
    await open(page, "?tooold&shell=phone");
    await expect(tooOld(page)).toContainText("Update Linger from Google Play.");
    await expect(tooOld(page).getByRole("button")).toHaveCount(0);
  });

  test.describe("an iPhone", () => {
    test.use({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" });

    test("points it at TestFlight, with no button", async ({ page }) => {
      await open(page, "?tooold&shell=phone");
      await expect(tooOld(page)).toContainText("Update Linger from TestFlight.");
      await expect(tooOld(page).getByRole("button")).toHaveCount(0);
    });
  });
});

test("a host whose server is behind hears it at the foot, with How to update (#772)", async ({ page }) => {
  await open(page, "?one&behind");
  await expect(notes(page)).toHaveText(["The Good Company is behind. 0.4.1 is out.How to update"]);
  await expect(notes(page)).toHaveAttribute("title", "It runs 0.4.0. Run ./update.sh in the server's folder to update it.");
  await notes(page).getByRole("button", { name: "How to update" }).click();
  expect(await did(page)).toContain("open https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#updating-the-server");
});

test("somebody who doesn't host the server isn't told it's behind (#772)", async ({ page }) => {
  await open(page, "?one&behind&guest");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
});

test("a server you host says when its disk is nearly full or it hasn't been backed up, and Server settings opens its Settings (#582, #772)", async ({ page }) => {
  await open(page, "?one&hostissues");
  await expect(notes(page)).toHaveText(["The disk The Good Company runs on is nearly full.Server settings", "The Good Company hasn't been backed up for 4 days.Server settings"]);
  await notes(page).first().getByRole("button", { name: "Server settings" }).click();
  expect((await did(page)).filter((line) => line.startsWith("next_open_settings")).at(-1)).toBe(`next_open_settings:${JSON.stringify({ section: "server", server: HOME })}`);
});

test("a server you host says when its backups haven't reached its bucket for days (#614)", async ({ page }) => {
  await open(page, "?one&hostbucket");
  await expect(notes(page)).toHaveText(["The Good Company's backups haven't reached its bucket for 4 days.Server settings"]);
  await notes(page).first().getByRole("button", { name: "Server settings" }).click();
  expect((await did(page)).filter((line) => line.startsWith("next_open_settings")).at(-1)).toBe(`next_open_settings:${JSON.stringify({ section: "server", server: HOME })}`);
});

test("a server somebody else hosts says nothing about its machine (#582)", async ({ page }) => {
  await page.clock.install();
  await open(page, "?one&hostissues&guest");
  await page.clock.runFor(10_000);
  await expect(page.locator("[data-screen='list-notes']")).toHaveCount(0);
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
  await expect(notes(page)).toHaveAttribute("title", /^Platform secure storage failure: zbus error/);
});

test("the foot's lines fit the list: nothing clipped or sideways, the words lined up", async ({ page }) => {
  await page.clock.install();
  await open(page, "?update");
  await expect(section(page, "Ashen Lanterns")).toBeVisible();
  await page.clock.runFor(1_000);
  await page.evaluate((server) => window.core?.status(server, { kind: "waiting", retry_in_ms: 4000, reason: "refused" }), GUILD);
  await page.clock.runFor(6_000);
  await expect(notes(page)).toHaveCount(1);
  await expect(updates(page)).toHaveCount(1);
  // A line and an update's block (#772) start their words on one edge.
  const measured = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".nx-note, .nx-update")].map((line) => {
      const words = line.querySelector<HTMLElement>(".nx-note-words, .nx-update-title");
      const box = line.getBoundingClientRect();
      return {
        left: words?.getBoundingClientRect().left ?? -1,
        inside: box.right <= document.documentElement.clientWidth && box.left >= 0,
        cut: words ? words.scrollWidth > words.clientWidth : true,
      };
    }),
  );
  expect(measured).toHaveLength(2);
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

test("the host, and only the host, can take somebody out of voice from their chip's card (#423)", async ({ page }) => {
  for (const [query, host] of [["?one", true], ["?one&guest", false]] as const) {
    await open(page, query);
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
    await bar.getByRole("button", { name: "Eli's volume, 100%" }).click();
    const card = page.getByRole("dialog", { name: "Eli's volume" });
    await expect(card.getByRole("slider")).toBeVisible();
    const takeOut = card.getByRole("button", { name: "Take out of voice" });
    if (!host) {
      await expect(takeOut).toHaveCount(0);
      continue;
    }
    await takeOut.click();
    await expect.poll(async () => did(page)).toContain("takeout r-general u-eli");
    await expect(card).toHaveCount(0);
  }
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
          { session_id: "s-good-company.example", user_id: "u-matt", forwarded: true },
          { session_id: "s-dave", user_id: "u-dave", forwarded: true },
          { session_id: "s-callie", user_id: "u-callie", forwarded: true },
          { session_id: "s-eli", user_id: "u-eli", forwarded: true },
          { session_id: "s-jules", user_id: "u-jules", forwarded: true },
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

test("somebody's card and row give Knock back the moment they come online (#288)", async ({ page }) => {
  await open(page, "?one");
  await page.getByRole("button", { name: /Offline/ }).click();
  const jen = page.getByRole("listitem").filter({ hasText: "Jen" });
  await jen.hover();
  await jen.getByRole("button", { name: "Jen's card" }).click();
  const card = page.getByRole("dialog", { name: "Jen" });
  await expect(card.getByRole("status")).toHaveText("Can't knock while Jen is offline.");
  await expect(card.getByRole("button", { name: "Knock" })).toBeDisabled();
  // Jen comes online while her card is open.
  await page.evaluate((server) => window.core?.frame(server, { op: "presence.update", d: { user_id: "u-jen", state: "around", room_id: null, away_message: null } } as never), HOME);
  await expect(card.getByRole("status")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Knock" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Knock" })).not.toHaveAccessibleDescription(/offline/);
  // Her row's Knock is back too.
  await page.keyboard.press("Escape");
  const row = page.getByRole("listitem").filter({ hasText: "Jen" });
  await row.hover();
  await expect(row.getByRole("button", { name: "Knock on Jen's door" })).toBeEnabled();
});
