import { expect, type Page, test } from "@playwright/test";

// Voice messages on the phone (#401, SPEC §4.15): the page records, with the
// web view's own microphone and its WebCodecs Opus encoder
// (app/chat/recorders.ts), into the same WebM file the desktop makes.
// Android's web view is Chromium, and reads the microphone with a track
// processor; the iPhone's is WebKit, which has none for sound, so there an
// audio worklet reads it (#687). Chromium stands in a fake microphone playing
// a tone, and goes the iPhone's way when its track processor is taken away.
// The panel itself, sending, and a voice message in the conversation are
// next-chat-parity.spec.ts's.

// Chromium only, and skipped before a browser starts: WebKit won't start at
// all with Chromium's fake-microphone switches below.
test.skip(({ browserName }) => browserName !== "chromium", "The phone's engine is Chromium, and only it stands in a microphone here.");

test.use({
  viewport: { width: 411, height: 914 },
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

async function did(page: Page): Promise<string[]> {
  return (await page.evaluate(() => document.body.dataset.did ?? "")).split("|");
}

/** The phone, in #general, once every connection is in (next-side.spec.ts says why, #355). */
async function inGeneral(page: Page) {
  await page.goto("/tests/fixtures/next-list-window.html?one&shell=phone");
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const lines = await did(page);
      const connects = lines.filter((line) => line.startsWith("connect ")).length;
      return connects > 0 && lines.filter((line) => line.startsWith("ready ")).length === connects;
    })
    .toBe(true);
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await expect(page.getByRole("log")).toContainText("Putting it on now.");
}

const panel = (page: Page) => page.getByRole("group", { name: "Voice message for #general" });

/** Record about a second and a half of the tone, stop, and check the file it made. */
async function recordAndHear(page: Page) {
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();

  // The tone moves the lines: some are taller than silence's dots.
  await expect
    .poll(() => panel(page).locator(".nx-voicemsg-lines i").evaluateAll((lines) => Math.max(...lines.map((line) => line.getBoundingClientRect().height))), { timeout: 5000 })
    .toBeGreaterThan(8);
  await page.waitForTimeout(1600);
  await panel(page).getByRole("button", { name: "Stop" }).click();
  await expect(panel(page).getByRole("button", { name: "Send voice message" })).toBeVisible();

  // A real file: WebM, Opus, as long as it was recorded, and this engine plays it.
  const heard = await panel(page)
    .locator("audio")
    .evaluate(async (audio: HTMLAudioElement) => {
      const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
      const head = Array.from(bytes.slice(0, 4));
      // The page's own AudioContext is the test page's stand-in for hearing sounds; an offline one decodes.
      const decoded = await new OfflineAudioContext(1, 48_000, 48_000).decodeAudioData(bytes.slice().buffer);
      return { head, seconds: decoded.duration, webm: new TextDecoder().decode(bytes.slice(0, 64)).includes("webm") };
    });
  expect(heard.head).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(heard.webm).toBe(true);
  expect(heard.seconds).toBeGreaterThan(1.2);
  expect(heard.seconds).toBeLessThan(6);
}

test("records from the phone's own microphone, lines moving, and plays back as the same kind of file", async ({ page }) => {
  await inGeneral(page);
  await recordAndHear(page);
});

test("with no track processor for sound, as on an iPhone, an audio worklet reads the microphone into the same file (#687)", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "MediaStreamTrackProcessor");
    // Which worklet the page loads, so the test knows which way it went.
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, options) {
      document.body.dataset.worklet = String(url);
      return add.call(this, url, options);
    };
  });
  await inGeneral(page);
  await recordAndHear(page);
  expect(await page.evaluate(() => document.body.dataset.worklet ?? "")).toContain("micWorklet");
});

test("a web view whose encoder can't make Opus, as an iPhone's before iOS 26, offers no microphone button", async ({ page }) => {
  await page.addInitScript(() => {
    AudioEncoder.isConfigSupported = (config) => Promise.resolve({ supported: false, config });
  });
  await inGeneral(page);
  await expect(page.getByRole("button", { name: "Emoji", exact: true })).toBeVisible();
  // Given the moment the encoder takes to answer.
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: "Record a voice message" })).toHaveCount(0);
});

/**
 * The phone's microphone held back (#920): each ask waits until the test
 * gives it, and the tracks it gave are kept to look at.
 */
async function holdMicrophone(page: Page) {
  await page.addInitScript(() => {
    if (typeof MediaDevices === "undefined") return;
    // On the prototype, as below (#843). Each ask waits until the test
    // gives the microphone, and the tracks it gave are kept to look at.
    const real = MediaDevices.prototype.getUserMedia;
    const held: Array<() => void> = [];
    const given: MediaStreamTrack[][] = [];
    Object.assign(window, { heldMicrophones: held, givenTracks: given });
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      value(this: MediaDevices, constraints?: MediaStreamConstraints) {
        return new Promise<MediaStream>((resolve, reject) => {
          held.push(() => {
            real.call(this, constraints).then((stream) => {
              given.push(stream.getTracks());
              resolve(stream);
            }, reject);
          });
        });
      },
      configurable: true,
    });
  });
  return {
    give: () => page.evaluate(() => (window as unknown as { heldMicrophones: Array<() => void> }).heldMicrophones.shift()?.()),
    live: (which: number) =>
      page.evaluate((index) => ((window as unknown as { givenTracks: MediaStreamTrack[][] }).givenTracks[index] ?? []).map((track) => track.readyState), which),
  };
}

for (const way of ["track processor", "audio worklet"] as const) {
test(`Escape while the phone's microphone opens (${way}): the microphone that comes later is let go of at once, and the next Record works (#920)`, async ({ page }) => {
  // The iPhone's way is the worklet (#687): forced here as the test above does.
  if (way === "audio worklet") await page.addInitScript(() => Reflect.deleteProperty(window, "MediaStreamTrackProcessor"));
  const { give, live } = await holdMicrophone(page);
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByText("Opening the microphone…")).toBeVisible();
  await panel(page).dispatchEvent("keydown", { key: "Escape" });
  await expect(panel(page)).toHaveCount(0);
  // The phone gives the microphone after all: it's let go of straight away.
  await give();
  await expect.poll(() => live(0)).toEqual(["ended"]);
  // And the next Record works.
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await give();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(await live(1)).toEqual(["live"]);
});
}

test("on a phone, Record asks for the microphone in the tap itself, as an iPhone needs (#687, #920)", async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(window, "MediaStreamTrackProcessor"));
  const { give } = await holdMicrophone(page);
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  const asked = await panel(page)
    .getByRole("button", { name: "Record" })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      return (window as unknown as { heldMicrophones: unknown[] }).heldMicrophones.length;
    });
  expect(asked).toBe(1);
  await give();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();
});

test("Escape, then Record again before the first microphone comes: the first is let go of, the second records (#920)", async ({ page }) => {
  const { give, live } = await holdMicrophone(page);
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await panel(page).dispatchEvent("keydown", { key: "Escape" });
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  // The first's microphone comes late: let go of at once, the second untouched.
  await give();
  await expect.poll(() => live(0)).toEqual(["ended"]);
  await give();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(await live(1)).toEqual(["live"]);
});

test("another room opened while the phone's microphone opens calls it off, and the microphone given later is let go of (#920)", async ({ page }) => {
  const { give, live } = await holdMicrophone(page);
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByText("Opening the microphone…")).toBeVisible();
  const chat = page.locator("[data-screen='chat']");
  await chat.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#weekend-plans\b/ }).click();
  await expect(chat.locator(".k-titlebar")).toContainText("weekend-plans");
  await give();
  await expect.poll(() => live(0)).toEqual(["ended"]);
  // Back in #general it's ready to record again, with nothing said, and does.
  await chat.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: /^#general\b/ }).click();
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(panel(page)).toContainText("Press Record when you're ready.");
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Record" }).click();
  await give();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();
});

/** What `tests/fixtures/page-recorder.ts` puts on the window, with the held encoder flushes. */
interface Driven {
  heldFlushes: Array<() => void>;
  pageRecorder: {
    start: () => Promise<string>;
    stop: () => void;
    stopped: (which: number) => Promise<number>;
    ended: () => string[];
  };
}

test("a start while the last stop still finishes: each recording keeps its own sound, and the old one's end says nothing (#920)", async ({ page }) => {
  // The encoder's last packets held back, so the first recording is still
  // finishing while the second records. The panel can't do this on a phone
  // (another room means the conversation goes, which calls a recording off),
  // so the recorder is driven on its own.
  await page.addInitScript(() => {
    const held: Array<() => void> = [];
    Object.assign(window, { heldFlushes: held });
    const real = AudioEncoder.prototype.flush;
    AudioEncoder.prototype.flush = function (this: AudioEncoder) {
      return new Promise<void>((resolve, reject) => held.push(() => void real.call(this).then(resolve, reject)));
    };
  });
  const flushes = () => page.evaluate(() => (window as unknown as Driven).heldFlushes.length);
  const letFlush = () => page.evaluate(() => void (window as unknown as Driven).heldFlushes.shift()?.());
  const start = () => page.evaluate(() => (window as unknown as Driven).pageRecorder.start());
  const stop = () => page.evaluate(() => (window as unknown as Driven).pageRecorder.stop());
  const stopped = (which: number) => page.evaluate((index) => (window as unknown as Driven).pageRecorder.stopped(index), which);
  await page.goto("/tests/fixtures/page-recorder.html");
  expect(await start()).toBe("started");
  await page.waitForTimeout(4000);
  await stop();
  await expect.poll(flushes).toBe(1);
  // The next start, while the first still finishes.
  expect(await start()).toBe("started");
  await page.waitForTimeout(1000);
  // The first's last packets come now, into the first.
  await letFlush();
  const first = await stopped(0);
  await page.waitForTimeout(300);
  await stop();
  await expect.poll(flushes).toBe(1);
  await letFlush();
  const second = await stopped(1);
  // Twenty milliseconds a packet. The first recorded four seconds before
  // the second began; handed the second's instead, it would have about
  // one second's, however slow the machine. The upper bounds are only sane.
  expect(first).toBeGreaterThan(150);
  expect(first).toBeLessThan(1000);
  expect(second).toBeGreaterThan(45);
  expect(second).toBeLessThan(1000);
  // The first's microphone ending, after the second began, isn't the second's.
  expect(await page.evaluate(() => (window as unknown as Driven).pageRecorder.ended())).toEqual([]);
});

test("a phone that won't give the microphone says so in words, and Record can be tried again", async ({ page }) => {
  await page.addInitScript(() => {
    if (typeof MediaDevices === "undefined") return;
    // On the prototype: WebKit may collect `navigator.mediaDevices` and make
    // it afresh, and a property added to the old one goes with it (#843).
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      value: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      configurable: true,
    });
  });
  await inGeneral(page);
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await panel(page).getByRole("button", { name: "Record" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Linger isn't allowed to use the microphone.");
  await expect(panel(page).getByRole("button", { name: "Record" })).toBeEnabled();
});
