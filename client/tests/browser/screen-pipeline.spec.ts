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
 * and `endWatch(code)` ends the watch as the server would. Each socket hears
 * `alive` every second, as the server's say it's still there; `quiet()`
 * stops that and everything else, a line that died without closing.
 * `behind()` tells the watcher its line couldn't keep up.
 *
 * The computer's sound (#736), as the real server passes it: a share whose
 * hello says it carries sound is asked for it (`want`'s `sound`) while its
 * watcher asks, and its packets reach a watcher that asked. `sound.in` counts
 * the packets the share sent; `hellos` keeps what each hello said.
 */
async function standIn(page: Page) {
  let share: WebSocketRoute | null = null;
  let watch: WebSocketRoute | null = null;
  let restarted = false;
  let silent = false;
  const asked: string[] = [];
  /** What each share's hello said it encodes. */
  const offered: unknown[] = [];
  const hellos: Record<string, unknown>[] = [];
  const sound = { carried: false, asked: false, in: 0, out: 0 };
  const want = () => JSON.stringify({ op: "want", codecs: ["vp8"], ...(sound.carried && sound.asked ? { sound: true } : {}) });
  const restart = async () => {
    restarted = true;
    await share?.close({ code: 1012, reason: "restarting" });
    await watch?.close({ code: 1012, reason: "restarting" });
  };
  await page.routeWebSocket(`${SERVER.replace("http", "ws")}/api/v1/screen`, (socket) => {
    // Its own close handler is the share's, below; the page closing ends it.
    const alive = setInterval(() => {
      try {
        if (!silent) socket.send(JSON.stringify({ op: "alive" }));
      } catch {
        clearInterval(alive);
      }
    }, 1_000);
    page.once("close", () => clearInterval(alive));
    socket.onMessage((message) => {
      if (silent) return;
      if (restarted) {
        // Not in voice: the restart forgot every session's seat.
        void socket.close({ code: 4002, reason: "not in voice" });
        return;
      }
      if (typeof message !== "string") {
        // A frame from the share: passed on to the watcher as it came. Sound
        // (its first byte 2) only to a watcher that asked, from a share that said.
        if (socket !== share) return;
        if (message[0] === 2) {
          sound.in += 1;
          if (!sound.carried || !sound.asked) return;
          sound.out += 1;
        }
        watch?.send(message);
        return;
      }
      const said = JSON.parse(message) as { op: string; target?: string; encode?: unknown; sound?: boolean; on?: boolean };
      asked.push(said.op);
      if (said.op === "share" || said.op === "watch") hellos.push(said);
      if (said.op === "sound") {
        sound.asked = said.on === true;
        share?.send(want());
        return;
      }
      if (said.op === "share") {
        offered.push(said.encode);
        share = socket;
        sound.carried = said.sound === true;
        socket.send(JSON.stringify({ op: "want", codecs: [] }));
        socket.onClose(() => {
          if (share !== socket) return;
          share = null;
          // A line that died says nothing, this included.
          if (!silent) watch?.send(JSON.stringify({ op: "showing", target: null, codec: null }));
        });
      } else if (said.op === "watch") {
        watch = socket;
        sound.asked = said.sound === true;
        socket.send(JSON.stringify({ op: "showing", target: said.target, codec: "vp8", ...(sound.carried ? { sound: true } : {}) }));
        share?.send(want());
        share?.send(JSON.stringify({ op: "keyframe", codec: "vp8" }));
      }
    });
  });
  const endWatch = async (code: number) => {
    await watch?.close({ code, reason: "ended" });
  };
  const quiet = (on = true) => {
    silent = on;
  };
  const behind = () => watch?.send(JSON.stringify({ op: "behind" }));
  return { asked, offered, restart, endWatch, quiet, behind, hellos, sound };
}

/** How many packets of a share's sound this page has played: in the shell, or in the page. */
const played = (page: Page) => page.evaluate(() => window.loop.sound_played());

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
  await expect.poll(state).toMatchObject({ status: "ended", opensNext: true });

  // Jules shares again: it opens on the same screen with nobody pressing Watch.
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await expect.poll(shares).toBe(2);
  await page.evaluate(() => window.loop.voice(true));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  expect(await state()).toMatchObject({ status: "showing", opensNext: false });
  expect(watches()).toBe(2);

  // Stopped again and the screen closed: the next share doesn't open it.
  await page.evaluate(() => window.loop.unfeed());
  await page.evaluate(() => window.loop.voice(false));
  await expect.poll(state).toMatchObject({ status: "ended", opensNext: true });
  await page.evaluate(() => window.loop.pane_close());
  await expect.poll(state).toMatchObject({ status: null, opensNext: false });
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await expect.poll(shares).toBe(3);
  await page.evaluate(() => window.loop.voice(true));
  await page.waitForTimeout(1000);
  expect(await state()).toMatchObject({ status: null, opensNext: false });
  expect(watches()).toBe(2);
});

test("a watch another of your windows takes over closes here, and doesn't come back by itself", async ({ page }) => {
  const { asked, endWatch } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
  // Another window of yours watches instead (4006): Jules never stopped, so
  // nothing here says they did; the screen goes, and doesn't come back, or
  // two windows would take it from each other.
  await endWatch(4006);
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status)).toBeNull();
  await page.evaluate(() => window.loop.voice(true));
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.loop.pane_state().status)).toBeNull();
  expect(asked.filter((op) => op === "watch")).toHaveLength(1);
});

test("leaving voice while watching closes the screen, without saying they stopped sharing", async ({ page }) => {
  const { endWatch } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
  // The server's 4007 for leaving voice comes before the room's voice says
  // you've gone, and Jules is still sharing.
  await endWatch(4007);
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status)).toBeNull();
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
const WENT_BLACK = "Everyone watching saw a black screen. If you're showing slides, stop sharing, then share again and pick Entire screen. PowerPoint plays a slide show in a window of its own, so sharing only the PowerPoint window comes out black.";
const NOTICE = { title: "Everyone watching sees a black screen", body: "If you're showing slides, stop sharing and share your entire screen, not just the PowerPoint window." };

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

test("a watcher's own slow line says so on its screen, for a while, and nobody else's", async ({ page }) => {
  const { behind } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate((server) => window.loop.feed(server, "s-jules"), SERVER);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
  expect(await page.evaluate(() => window.loop.pane_state().behind)).toBe(false);
  // The server skipped this watcher forward: its line couldn't keep up.
  behind();
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().behind)).toBe(true);
  // It caught up: six seconds later, with nothing more said, the note goes.
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().behind), { timeout: 10_000 }).toBe(false);
  expect(await page.evaluate(() => window.loop.pane_state().status)).toBe("showing");
});

test("a line that goes silent without closing is taken as dropped, and the share and the screen come back by themselves", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit can't read a screen the way the Linux app does");
  const { asked, quiet } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  await page.evaluate(() => window.loop.silence(1_500));
  await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
  await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
  await page.evaluate(() => window.loop.paint("#ff0000"));
  await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  // The line dies without closing: nothing more from the server, not even
  // its alive, and nothing it's sent is answered. A still slide would look
  // the same, and nothing would ever say otherwise.
  quiet();
  await page.waitForTimeout(2_500);
  quiet(false);
  // Both took it as dropped and said hello again; the picture follows the screen.
  await expect.poll(() => asked.filter((op) => op === "share").length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => asked.filter((op) => op === "watch").length, { timeout: 15_000 }).toBe(2);
  await page.evaluate(() => window.loop.paint("#0000ff"));
  await expect.poll(() => colour(page).then((got) => near(got, [0, 0, 255, 255])), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(() => (window.loop.share_state() as { status?: string } | null)?.status)).toBe("sharing");
});

// A watcher with no desktop shell plays a share's sound in the page (#736),
// as a phone does: the web engine's own Opus decoder, then Web Audio.
test("without the shell, a watcher plays a share's sound with the page's own decoder, and its button stops it", async ({ page }) => {
  const { hellos, sound } = await standIn(page);
  await page.goto("/tests/fixtures/screen-loop.html");
  const engine = await page.evaluate(async () => {
    if (typeof AudioEncoder !== "function" || typeof AudioDecoder !== "function") return false;
    return (await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 48_000, numberOfChannels: 2 })).supported === true;
  });
  test.skip(!engine, "this engine has no WebCodecs Opus to make or play the sound with");
  // Jules shares with the computer's sound, made here as real Opus.
  await page.evaluate((server) => window.loop.feed(server, "s-jules", true), SERVER);
  await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
  await page.evaluate(() => window.loop.voice(true));
  await page.evaluate(() => window.loop.pane_watch("s-jules"));
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
  expect(hellos.find((hello) => hello.op === "watch")).toMatchObject({ sound: true });
  expect(await page.evaluate(() => window.loop.pane_state().sound)).toEqual({ playable: true, on: true });
  await expect.poll(() => played(page), { timeout: 10_000 }).toBeGreaterThan(10);
  // The screen's speaker off: the server is told, nothing more comes, and nothing more plays.
  await page.evaluate(() => window.loop.pane_sound());
  await expect.poll(() => page.evaluate(() => window.loop.pane_state().sound)).toEqual({ playable: true, on: false });
  await expect.poll(() => sound.asked).toBe(false);
  await page.waitForTimeout(300);
  const stopped = await played(page);
  const passed = sound.out;
  await page.waitForTimeout(1_000);
  expect(await played(page)).toBe(stopped);
  expect(sound.out).toBe(passed);
  await page.evaluate(() => window.loop.watch_sound(true));
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

  test("where the shell has WebKit draw without the GPU, Watch says this device can't play, and no decoder is built (#729)", async ({ page }) => {
    const { asked } = await standIn(page);
    // In the real app, building one there aborts the whole page.
    await page.addInitScript(() => {
      const built: string[] = [];
      Reflect.set(window, "decodersBuilt", built);
      const Real = window.VideoDecoder;
      const Counted = function (this: unknown, init: VideoDecoderInit) {
        built.push("new");
        return new Real(init);
      };
      Object.assign(Counted, {
        isConfigSupported: (config: VideoDecoderConfig) => {
          built.push(`asked ${config.codec}`);
          return Real.isConfigSupported(config);
        },
      });
      Reflect.set(window, "VideoDecoder", Counted);
    });
    await page.goto("/tests/fixtures/screen-loop.html?shell&cpu");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
    await expect.poll(() => page.evaluate(() => (window.loop.watch_state() as { status?: string } | null)?.status)).toBe("unplayable");
    expect(await page.evaluate(() => Reflect.get(window, "decodersBuilt"))).toEqual([]);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_watch_available");
    // Nothing is asked of the server for a screen it can't play.
    expect(asked).toEqual(["share"]);
  });

  test("through the shell, the hello offers what the shell makes, H.264 first, and the watchers' want reaches it (#733)", async ({ page }) => {
    const { offered } = await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell&formats=avc1,vp8");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 60), SERVER);
    await expect.poll(() => offered.length).toBe(1);
    expect(offered).toEqual([["avc1", "vp8"]]);
    // Nobody watching yet: the server wants nothing, and the shell encodes nothing.
    await expect.poll(() => page.evaluate(() => window.loop.shell_asked())).toContain("want ");
    // A watcher who plays VP8: the shell encodes it, and the picture plays.
    await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
    await expect.poll(() => page.evaluate(() => window.loop.shell_asked())).toContain("want vp8");
    await page.evaluate(() => window.loop.paint("#ff0000"));
    await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
  });

  test("through the shell, a shell that says nothing it makes is a VP8 share, as before (#733)", async ({ page }) => {
    const { offered } = await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await expect.poll(() => offered.length).toBe(1);
    expect(offered).toEqual([["vp8"]]);
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

  test("through the shell, a share from a conversation's own window gone black asks the list window for the notice", async ({ page }) => {
    await standIn(page);
    // Only the list window may raise a notice (show_notification is the owner's).
    await page.goto("/tests/fixtures/screen-loop.html?shell&label=chat-general");
    await page.evaluate((server) => window.loop.pane(server, "s-me", true), SERVER);
    await page.evaluate(() => window.loop.voice(false));
    await page.evaluate((server) => window.loop.share(server, "token", "s-me", 30), SERVER);
    await page.evaluate(() => window.loop.paint("#000000"));
    await expect(page.getByRole("alert")).toHaveText(WENT_BLACK, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => window.loop.shell_asked().filter((asked) => asked === "emit_to next:screen-black"))).toHaveLength(1);
    expect(await page.evaluate(() => window.loop.notices())).toEqual([]);
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

  // The computer's sound in a share (#736). The stand-in shell captures it as
  // the Windows app's does; which desktop it is makes no difference to the page.
  test("with the switch off, a share sends no sound, says none, and the shell captures none", async ({ page }) => {
    const { hellos, sound } = await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.share(server, "token", "s-sharer", 30), SERVER);
    await page.evaluate((server) => window.loop.watch(server, "token", "s-watcher", "s-sharer"), SERVER);
    await page.evaluate(() => window.loop.paint("#ff0000"));
    await expect.poll(() => colour(page).then((got) => near(got, [255, 0, 0, 255])), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(1_000);
    // The share's hello is as it was before sound; the watcher still asks,
    // and is told there's none.
    expect(Object.keys(hellos.find((hello) => hello.op === "share") ?? {}).sort()).toEqual(["encode", "fps", "op", "session_id", "token"]);
    expect(hellos.find((hello) => hello.op === "watch")).toMatchObject({ sound: true });
    expect(sound.in).toBe(0);
    expect(await page.evaluate(() => window.loop.shell_asked())).not.toContain("screen_sound_start");
    expect(await played(page)).toBe(0);
    expect(await page.evaluate(() => window.loop.watch_state())).not.toHaveProperty("sound");
  });

  test("with the switch on, the computer's sound reaches the watcher's shell, and the watcher's sound button stops it", async ({ page }) => {
    const { asked, hellos, sound } = await standIn(page);
    await page.goto("/tests/fixtures/screen-loop.html?shell");
    await page.evaluate((server) => window.loop.share(server, "token", "s-jules", 30, true), SERVER);
    await expect.poll(() => hellos[0]).toMatchObject({ op: "share", sound: true });
    expect(await page.evaluate(() => window.loop.share_state())).toMatchObject({ sound: "on" });
    // Nobody watching yet: the shell captures, and nothing goes out.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_sound_start");
    expect(sound.in).toBe(0);
    // You watch it from the room's screen, its sound on, as it starts.
    await page.evaluate((server) => window.loop.pane(server, "s-watcher"), SERVER);
    await page.evaluate(() => window.loop.voice(true));
    await page.evaluate(() => window.loop.pane_watch("s-jules"));
    await expect.poll(() => page.evaluate(() => window.loop.pane_state().status), { timeout: 15_000 }).toBe("showing");
    expect(await page.evaluate(() => window.loop.pane_state().sound)).toEqual({ playable: true, on: true });
    await expect.poll(() => sound.out, { timeout: 10_000 }).toBeGreaterThan(10);
    await expect.poll(() => played(page), { timeout: 10_000 }).toBeGreaterThan(10);
    // Its speaker off: the server is told, the share stops sending, the shell lets go.
    await page.evaluate(() => window.loop.pane_sound());
    await expect.poll(() => asked.includes("sound")).toBe(true);
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_sound_end");
    await page.waitForTimeout(300);
    const [sent, heard] = [sound.in, await played(page)];
    await page.waitForTimeout(1_000);
    expect(sound.in).toBe(sent);
    expect(await played(page)).toBe(heard);
    // And on again: it comes back.
    await page.evaluate(() => window.loop.pane_sound());
    await expect.poll(() => played(page), { timeout: 10_000 }).toBeGreaterThan(heard + 10);
    // Stop ends the capture.
    await page.evaluate(() => window.loop.stop());
    expect(await page.evaluate(() => window.loop.shell_asked())).toContain("screen_sound_stop");
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
