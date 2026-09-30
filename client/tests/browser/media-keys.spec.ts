import { expect, test } from "@playwright/test";

// The desktop's play and pause for the real app page (#353, lib/mediaKeys.ts):
// `next.html` answers the Media Session API's actions itself, so a "Play"
// from outside (a media key, MPRIS on Linux, a dictation tool resuming what
// it paused) resumes only what an outside "Pause" paused, and never starts a
// song you paused. The browser can't press the desktop's keys, so the page's
// handlers are caught as the app hands them over and called the way the
// desktop would.

declare global {
  interface Window {
    desktopKeys: Partial<Record<string, () => void>>;
    song: HTMLAudioElement;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.desktopKeys = {};
    const session = navigator.mediaSession;
    const real = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => {
      window.desktopKeys[action] = handler ? () => handler({ action }) : undefined;
      try {
        real(action, handler);
      } catch {
        // An engine that doesn't know one of the actions: the app's handler is still what's tested.
      }
    };
  });
  await page.goto("/next.html");
  await expect.poll(() => page.evaluate(() => Object.keys(window.desktopKeys).sort())).toEqual(["pause", "play", "stop"]);
  // A second of silence to play, muted so no click is needed to start it.
  await page.evaluate(() => {
    const rate = 8000;
    const samples = rate;
    const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at: number, words: string) => [...words].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    bytes.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVEfmt ");
    bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true);
    bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true);
    bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true);
    bytes.setUint16(34, 16, true);
    text(36, "data");
    bytes.setUint32(40, samples * 2, true);
    const song = document.createElement("audio");
    song.src = URL.createObjectURL(new Blob([bytes.buffer], { type: "audio/wav" }));
    song.muted = true;
    song.loop = true;
    document.body.append(song);
    window.song = song;
  });
});

test("a song you paused stays paused when the desktop says pause, then play", async ({ page }) => {
  await page.evaluate(() => window.song.play());
  await page.evaluate(() => window.song.pause());
  await page.evaluate(() => {
    window.desktopKeys.pause?.();
    window.desktopKeys.play?.();
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.song.paused)).toBe(true);
});

test("a song that's playing pauses when the desktop says so, and comes back when it says play", async ({ page }) => {
  await page.evaluate(() => window.song.play());
  await page.evaluate(() => window.desktopKeys.pause?.());
  expect(await page.evaluate(() => window.song.paused)).toBe(true);
  await page.evaluate(() => window.desktopKeys.play?.());
  await expect.poll(() => page.evaluate(() => window.song.paused)).toBe(false);
  // And it tells the desktop it's playing.
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("playing");
});
