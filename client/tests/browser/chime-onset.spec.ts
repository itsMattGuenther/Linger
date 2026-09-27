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
    expect(results).toHaveLength(13);
    for (const result of results) {
      expect(result.error, result.cue).toBeLessThan(0.000001);
      expect(result, result.cue).toMatchObject({ leadSilent: true, endSilent: true });
      expect(result.peak, result.cue).toBeGreaterThan(0.01);
      expect(result.peak, result.cue).toBeLessThan(0.2);
      expect(result.duration, result.cue).toBeLessThan(0.6);
    }
  });

  // The sound volume (#234) is one gain after the whole score, so a cue at
  // 150% is the same wave 1.5 times higher, and the top of the range was
  // picked by rendering every cue there. At 100% the loudest cue is the
  // knock's first tap, at 0.16 of full scale (the loudest chime, voice-move,
  // is 0.052); at the top, 400%, the knock is at 0.64, clear of clipping.
  test(`the sound volume scales every cue alike, and none clips at the top, at ${rate} Hz`, async ({ page }) => {
    await page.goto("/tests/fixtures/sounds.html");
    const { max, results } = await page.evaluate(async (sampleRate) => {
      const chimesPath = "/src/lib/chimes.ts";
      const soundPath = "/src/lib/sound.ts";
      const { renderChime, CHIMES }: typeof import("../../src/lib/chimes") = await import(chimesPath);
      const { MAX_SOUND_VOLUME }: typeof import("../../src/lib/sound") = await import(soundPath);
      const cues = [...Object.keys(CHIMES), "knock"] as import("../../src/lib/sound").SoundCue[];
      const peak = (samples: Float32Array) => samples.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
      const results = [];
      for (const cue of cues) {
        const usual = (await renderChime(cue, sampleRate)).getChannelData(0);
        const louder = (await renderChime(cue, sampleRate, 1.5)).getChannelData(0);
        const top = (await renderChime(cue, sampleRate, MAX_SOUND_VOLUME)).getChannelData(0);
        results.push({
          cue,
          usual: peak(usual),
          louder: peak(louder),
          top: peak(top),
          // How far the 150% wave is from the 100% wave times 1.5, anywhere.
          misshapen: louder.reduce((most, value, index) => Math.max(most, Math.abs(value - 1.5 * (usual[index] ?? 0))), 0),
        });
      }
      return { max: MAX_SOUND_VOLUME, results };
    }, rate);
    expect(results).toHaveLength(13);
    expect(max).toBe(4);
    const loudest = results.reduce((most, result) => (result.usual > most.usual ? result : most));
    expect(loudest.cue).toBe("knock");
    expect(loudest.usual).toBeCloseTo(0.16, 2);
    expect(loudest.top).toBeCloseTo(0.64, 2);
    for (const result of results) {
      expect(result.louder / result.usual, result.cue).toBeCloseTo(1.5, 5);
      expect(result.misshapen, result.cue).toBeLessThan(0.000001);
      expect(result.top / result.usual, result.cue).toBeCloseTo(max, 4);
      expect(result.top, result.cue).toBeLessThanOrEqual(0.8);
    }
  });
}
