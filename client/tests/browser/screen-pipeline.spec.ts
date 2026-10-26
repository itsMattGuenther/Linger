import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";

// The screen-sharing pipeline in the engine itself (#360): a share made with
// this engine's WebCodecs, sent on a screen socket, and played on another
// socket's watcher onto a canvas, through a stand-in for the server that
// says what the real one says and passes each frame on
// (tests/fixtures/screen-loop.html). The real server is
// `crates/linger-server/tests/screen.rs` and `scripts/screen-loop.mjs`.

const SERVER = "http://screen.test";

/**
 * The server's part, as far as one share and one watcher need it.
 * `restart()` drops both sockets the way a restarting server does; once
 * back, it has no seat for anybody, as a restarted server hasn't. A share
 * that stops tells its watcher there's nothing to show, keeping its socket,
 * and `endWatch(code)` ends the watch as the server would.
 */
async function standIn(page: Page) {
  let share: WebSocketRoute | null = null;
  let watch: WebSocketRoute | null = null;
  let restarted = false;
  const asked: string[] = [];
  const restart = async () => {
    restarted = true;
    await share?.close({ code: 1012, reason: "restarting" });
    await watch?.close({ code: 1012, reason: "restarting" });
  };
  await page.routeWebSocket(`${SERVER.replace("http", "ws")}/api/v1/screen`, (socket) => {
    socket.onMessage((message) => {
      if (restarted) {
        // Not in voice: the restart forgot every session's seat.
        void socket.close({ code: 4002, reason: "not in voice" });
        return;
      }
      if (typeof message !== "string") {
        // A frame from the share: passed on to the watcher as it came.
        if (socket === share) watch?.send(message);
        return;
      }
      const said = JSON.parse(message) as { op: string; target?: string };
      asked.push(said.op);
      if (said.op === "share") {
        share = socket;
        socket.send(JSON.stringify({ op: "want", codecs: [] }));
        socket.onClose(() => {
          if (share !== socket) return;
          share = null;
          watch?.send(JSON.stringify({ op: "showing", target: null, codec: null }));
        });
      } else if (said.op === "watch") {
        watch = socket;
        socket.send(JSON.stringify({ op: "showing", target: said.target, codec: "vp8" }));
        share?.send(JSON.stringify({ op: "want", codecs: ["vp8"] }));
        share?.send(JSON.stringify({ op: "keyframe", codec: "vp8" }));
      }
    });
  });
  const endWatch = async (code: number) => {
    await watch?.close({ code, reason: "ended" });
  };
  return { asked, restart, endWatch };
}

async function colour(page: Page): Promise<number[]> {
  return page.evaluate(() => window.loop.pixel());
}

function near(got: number[], want: number[]): boolean {
  return got.length === 4 && want.every((value, at) => Math.abs(value - (got[at] ?? -1000)) < 40);
}

test("a screen shared here plays on a watcher here, and follows what the screen shows", async ({ page, browserName }) => {
  // The Linux app reads the screen in a worker, with the track processor its
  // shell turns on (T-1907, `reader.worker.ts`, tested on its own). Playwright's
  // WebKit has none there, so it would read through the hidden video, a way
  // the app only falls back to, and one WebKit doesn't play in a page in the
  // background. Watching in WebKit is the next test.
  test.skip(browserName === "webkit", "Playwright's WebKit can't read a screen the way the Linux app does");
  const { asked } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(() => window.loop.watch_state())).toMatchObject({ status: "showing", width: 640, height: 360 });
  expect(asked).toEqual(["share", "watch"]);
});

test("a share plays on a watcher in this engine, and follows what it shows", async ({ page }) => {
  await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  // The share made by the test page itself, from a canvas (see `feed`).
  await page.evaluate((server) => window.loop.feed(server, "s-sharer"), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(() => window.loop.watch_state())).toMatchObject({ status: "showing", width: 640, height: 360 });
});

test("a screen left open opens the same person's next share by itself, and a closed one stays closed", async ({ page }) => {
  const { asked } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  const watches = () => asked.filter((op) => op === "watch").length;
  const shares = () => asked.filter((op) => op === "share").length;
  const state = () => page.evaluate(() => window.loop.pane_state());
  // Jules shares in #general's voice, where you are, and you press Watch.
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await expect.poll(shares).toBe(1);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);

  // Jules stops, to pick another window: the screen stays, saying so.
  await page.evaluate(() => window.loop.unfeed());
  await page.evaluate(() => window.loop.voice(false));
  await expect.poll(state).toEqual({ status: "ended", opensNext: true });

  // Jules shares again: it opens on the same screen with nobody pressing Watch.
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await expect.poll(shares).toBe(2);
  await page.evaluate(() => window.loop.voice(true));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  expect(await state()).toEqual({ status: "showing", opensNext: false });
  expect(watches()).toBe(2);

  // Stopped again and the screen closed: the next share doesn't open it.
  await page.evaluate(() => window.loop.unfeed());
  await page.evaluate(() => window.loop.voice(false));
  await expect.poll(state).toEqual({ status: "ended", opensNext: true });
  await page.evaluate(() => window.loop.pane_close());
  await expect.poll(state).toEqual({ status: null, opensNext: false });
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await expect.poll(shares).toBe(3);
  await page.evaluate(() => window.loop.voice(true));
  await page.waitForTimeout(1000);
  expect(await state()).toEqual({ status: null, opensNext: false });
  expect(watches()).toBe(2);
});

test("a watch that ends while its person still shares doesn't come back by itself", async ({ page }) => {
  const { asked, endWatch } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
  // Another window of yours watches instead (4006): Jules never stopped, so
  // this one stays over, or two windows would take it from each other.
  await endWatch(4006);
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status)).toBe("ended");
  await page.evaluate(() => window.loop.voice(true));
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.loop.pane_state().status)).toBe("ended");
  expect(asked.filter((op) => op === "watch")).toHaveLength(1);
});

test("when the server restarts, a share and a watcher end saying the connection went", async ({ page }) => {
  const server = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await expect.poll(() => page.evaluate(() => (window.loop.share_state() as { status?: string } | null)?.status)).toBe("sharing");
  await server.restart();
  // Each tries again once (a second on), finds no seat, and says what went:
  // the connection, not that somebody stopped.
  await expect.poll(() => page.evaluate(() => window.loop.share_stopped()), { timeout: 10_000 }).toBe("dropped");
  expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
  await expect.poll(() => page.evaluate(() => (window.loop.watch_state() as { status?: string } | null)?.status), { timeout: 10_000 }).toBe("lost");
});

test("a picker that fails says the computer gave no screen; one closed by the person says nothing", async ({ page }) => {
  await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate(() => window.loop.picker("NotAllowedError"));
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  expect(await page.evaluate(() => window.loop.share_stopped())).toBeNull();
  expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
  // A desktop with no screen portal, say (T-1907).
  await page.evaluate(() => window.loop.picker("NotFoundError"));
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  expect(await page.evaluate(() => window.loop.share_stopped())).toBe("no-screen");
  expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
});

test("a screen that never sends a picture stops sharing and says so", async ({ page }) => {
  await standIn(page);
  await page.clock.install();
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate(() => window.loop.picker("blank"));
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  // Connected, and saying it shares, with nothing going out.
  await expect.poll(() => page.evaluate(() => (window.loop.share_state() as { status?: string } | null)?.status)).toBe("sharing");
  await page.clock.fastForward(9_000);
  await expect.poll(() => page.evaluate(() => window.loop.share_stopped())).toBe("no-frames");
  expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
});

// What hiding the preview broke on Linux (the whole share stopped, and a
// share starting hidden never started), checked where the page shares for
// itself (Windows): the copy is the page's own video of the screen.
test("hiding your share's copy keeps the share going, and a share that starts hidden starts", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit can't read a screen the way the Linux app does");
  await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await page.evaluate(() => window.loop.box());
  const box = page.getByRole("group", { name: "Your screen" });
  await expect(box.locator("video")).toHaveCount(1);
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  await box.getByRole("button", { name: "Show the preview" }).click();
  await expect(box.locator("video")).toHaveCount(0);
  // Hidden, the screen still goes out: the watcher follows it.
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  // A share started with it hidden starts, and plays.
  await page.evaluate(() => window.loop.stop());
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
});

// A slide show runs in a window of its own, so PowerPoint's window, shared,
// comes out black (lib/screen/black.ts). Where the page shares for itself
// (Windows), it looks at a small copy once a second.
const WENT_BLACK = "Your share went black for everybody watching. Shared one window for a slide show? Stop, then share your entire screen.";
const NOTICE = { title: "Your share is black", body: "Everybody watching sees black. Shared one window for a slide show? Stop, then share your entire screen." };

const wentBlack = (page: Page) => page.evaluate(() => (window.loop.share_state() as { wentBlack?: boolean } | null)?.wentBlack ?? null);

test("a share that stays black is marked so until it stops, even once it's back, and a dark one isn't", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit can't read a screen the way the Linux app does");
  await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  expect(await wentBlack(page)).toBe(false);
  // A dark slide, past the five seconds black would have had, isn't black.
  await page.evaluate(() => window.loop.paint("#101830"));
  await expect.poll(() => colour(page).then((got) => near(got, [16, 24, 48, 255])), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(6_500);
  expect(await wentBlack(page)).toBe(false);
  // The slide show starts, and the window shared goes black.
  await page.evaluate(() => window.loop.paint("#000000"));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => wentBlack(page), { timeout: 15_000 }).toBe(true);
  // Out of the slide show the window is back, and with it the box, where
  // it's still said: it went black while nobody here could see the box.
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  expect(await wentBlack(page)).toBe(true);
  // A new share starts with nothing said.
  await page.evaluate(() => window.loop.stop());
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  expect(await wentBlack(page)).toBe(false);
});

// The Linux app shares through its shell (T-1907, src-tauri/src/screen_shell.rs),
// played here by the test page (`?shell`): the shell's frames go out on the
// same screen socket, and a watcher plays them. Each engine says it's the
// Linux app's: Playwright's WebKit otherwise says it's Safari on a Mac.
test.describe("through the Linux app's shell", () => {
  test.use({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" });

  test("on Linux a screen shared through the shell plays on a watcher, and follows what the screen shows", async ({ page }) => {
    const { asked } = await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 60), SERVER);
    await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
    await page.evaluate(() => window.loop.paint("#ff0000"));
    await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
    await page.evaluate(() => window.loop.paint("#0000ff"));
    await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
    expect(asked).toEqual(["share", "watch"]);
    // The page never asked its engine for the screen; the shell was asked,
    // and for a key frame when somebody started watching.
    const told = await page.evaluate(() => window.loop.shell_asked());
    expect(told.slice(0, 1)).toEqual(["screen_share_start"]);
    expect(told).toContain("screen_share_keyframe");
    await page.evaluate(() => window.loop.stop());
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_share_stop");
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
  });

  test("through the shell, a closed picker says nothing, and one with nothing to encode says so", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate(() => window.loop.shell("declined"));
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    expect(await page.evaluate(() => window.loop.share_stopped())).toBeNull();
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
    await page.evaluate(() => window.loop.shell("no-encoder"));
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    expect(await page.evaluate(() => window.loop.share_stopped())).toBe("no-encoder");
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
  });

  test("a share through the shell that loses the screen stops and says it couldn't read it", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate(() => window.loop.shell("fails"));
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await expect.poll(() => page.evaluate(() => window.loop.share_stopped()), { timeout: 10_000 }).toBe("no-frames");
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_share_stop");
  });

  test("through the shell, a share gone black says so under it, and once on the desktop", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.pane(server, "s-me", true), SERVER);
    await page.evaluate(() => window.loop.voice(false));
    await page.evaluate((server) => window.loop.share(server, "token", "s-me", 30), SERVER);
    await expect(page.getByRole("group", { name: "Your screen" })).toBeVisible();
    await page.evaluate(() => window.loop.paint("#000000"));
    await expect(page.getByRole("alert")).toHaveText(WENT_BLACK, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => window.loop.notices())).toEqual([{ ...NOTICE, open: null }]);
    // Said once a share, however long it stays black.
    await page.waitForTimeout(2_500);
    expect(await page.evaluate(() => window.loop.notices())).toHaveLength(1);
  });

  test("through the shell, your share's copy shows the shell's pictures, and hidden the shell stops making them", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await page.evaluate(() => window.loop.box());
    const box = page.getByRole("group", { name: "Your screen" });
    const picture = box.locator("img");
    await expect.poll(() => picture.getAttribute("src"), { timeout: 10_000 }).toMatch(/^blob:/);
    expect(await picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await box.getByRole("button", { name: "Show the preview" }).click();
    await expect(picture).toHaveCount(0);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_share_preview");
  });

  test("a share from a popped-out conversation has its box there: the shell's copy, who's watching, and Stop", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    // A popped-out #general, you and Jules in its voice, and you share from it.
    await page.evaluate((server) => window.loop.pane(server, "s-me", true), SERVER);
    await page.evaluate(() => window.loop.voice(false));
    await page.evaluate((server) => window.loop.share(server, "token", "s-me", 30), SERVER);
    const box = page.getByRole("group", { name: "Your screen" });
    await expect.poll(() => box.locator("img").getAttribute("src"), { timeout: 10_000 }).toMatch(/^blob:/);
    await expect(box.getByRole("status")).toHaveText("Nobody's watching yet");
    await page.evaluate(() => window.loop.voice(false, "s-me"));
    await expect(box.getByRole("status")).toHaveText("Jules is watching");
    // The eye stops the shell making the copy, as in the voice bar.
    await box.getByRole("button", { name: "Show the preview" }).click();
    await expect(box.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_share_preview");
    await box.getByRole("button", { name: "Stop" }).click();
    await expect(box).toHaveCount(0);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_share_stop");
  });

  test("beside the list, a conversation leaves your share's box to the voice bar", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.pane(server, "s-me", false), SERVER);
    await page.evaluate(() => window.loop.voice(false));
    await page.evaluate((server) => window.loop.share(server, "token", "s-me", 30), SERVER);
    await expect.poll(() => page.evaluate(() => (window.loop.share_state() as { status?: string } | null)?.status)).toBe("sharing");
    await expect(page.getByRole("group", { name: "Your screen" })).toHaveCount(0);
  });

  test("a share from a popped-out conversation that loses the screen says why there", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.pane(server, "s-me", true), SERVER);
    await page.evaluate(() => window.loop.voice(false));
    await page.evaluate(() => window.loop.shell("fails"));
    await page.evaluate((server) => window.loop.share(server, "token", "s-me", 30), SERVER);
    await expect(page.getByRole("status", { name: "Why sharing stopped" })).toHaveText("Linger couldn't read the screen you picked, so sharing stopped.", { timeout: 10_000 });
    await expect(page.getByRole("group", { name: "Your screen" })).toHaveCount(0);
  });

  test("Stop while the shell's picker is open shares nothing when it answers", async ({ page }) => {
    await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate(() => window.loop.shell("waits"));
    const sharing = page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await expect.poll(() => page.evaluate(() => (window.loop.share_state() as { status?: string } | null)?.status)).toBe("picking");
    await page.evaluate(() => window.loop.stop());
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
    await page.evaluate(() => window.loop.pick());
    await sharing;
    expect(await page.evaluate(() => window.loop.share_state())).toBeNull();
    // The share it picked was stopped at once.
    expect((await page.evaluate(() => window.loop.shell_asked())).at(-1)).toBe("screen_share_stop");
  });
});
