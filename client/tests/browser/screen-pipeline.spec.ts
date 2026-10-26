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
 * back, it has no seat for anybody, as a restarted server hasn't.
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
      } else if (said.op === "watch") {
        watch = socket;
        socket.send(JSON.stringify({ op: "showing", target: said.target, codec: "vp8" }));
        share?.send(JSON.stringify({ op: "want", codecs: ["vp8"] }));
        share?.send(JSON.stringify({ op: "keyframe", codec: "vp8" }));
      }
    });
  });
  return { asked, restart };
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
