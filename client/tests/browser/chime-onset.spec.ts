import { expect, test } from "@playwright/test";

for (const rate of [44100, 48000]) {
  test(`prepared chimes preserve the score and a silent lead at ${rate} Hz`, async ({ page }) => {
    await page.goto("/tests/fixtures/sounds.html");
    const results = await page.evaluate(async (sampleRate) => {
      const path = "/src/lib/chimes.ts";
      const { renderChime, scheduleChime, CHIMES }: typeof import("../../src/lib/chimes") = await import(path);
      const cues = [...Object.keys(CHIMES), "knock"] as import("../../src/lib/sound").SoundCue[];
      const result = [];
      for (const cue of cues) {
        const buffer = await renderChime(cue, sampleRate);
        const samples = buffer.getChannelData(0);
        const reference = new OfflineAudioContext(1, buffer.length, sampleRate);
        scheduleChime(reference, cue, 0.05);
        const original = (await reference.startRendering()).getChannelData(0);
        result.push({
          cue,
          error: samples.reduce((error, value, index) => Math.max(error, Math.abs(value - (original[index] ?? 0))), 0),
          leadSilent: samples.slice(0, Math.floor(sampleRate * 0.05)).every((value) => value === 0),
          endSilent: samples.slice(-Math.floor(sampleRate * 0.004)).every((value) => value === 0),
          peak: samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0),
          duration: buffer.duration,
        });
      }
      return result;
    }, rate);
    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result.error, result.cue).toBeLessThan(0.000001);
      expect(result, result.cue).toMatchObject({ leadSilent: true, endSilent: true });
      expect(result.peak, result.cue).toBeGreaterThan(0.01);
      expect(result.peak, result.cue).toBeLessThan(0.2);
      expect(result.duration, result.cue).toBeLessThan(0.6);
    }
  });
}
