import { describe, expect, it } from "vitest";
import { END_MARGIN, knownSeconds, loadAudioVolume, onStep, saveAudioVolume, seekStep, seekTarget, timeSizer, timeText, timeWords } from "./audioPlayer";
import type { ModeStore } from "./conversations";

function memory(): ModeStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

describe("how loud shared audio starts (#247)", () => {
  it("starts at full, then at the last level let go of, on this computer", () => {
    const store = memory();
    expect(loadAudioVolume(store)).toBe(1);
    saveAudioVolume(store, 0.35);
    expect(loadAudioVolume(store)).toBe(0.35);
    saveAudioVolume(store, 1);
    expect(loadAudioVolume(store)).toBe(1);
    expect([...store.items.keys()]).toEqual(["linger.next.audioVolume"]);
  });

  it("never remembers silence, so a file never starts out mute", () => {
    const store = memory();
    saveAudioVolume(store, 0.6);
    saveAudioVolume(store, 0);
    expect(loadAudioVolume(store)).toBe(0.6);
    store.setItem("linger.next.audioVolume", "0");
    expect(loadAudioVolume(store)).toBe(1);
  });

  it("reads anything else as full, and survives storage that refuses", () => {
    const store = memory();
    for (const odd of ["loud", "", "-0.5", "1.5", "NaN", "Infinity"]) {
      store.setItem("linger.next.audioVolume", odd);
      expect(loadAudioVolume(store)).toBe(1);
    }
    saveAudioVolume(store, 7);
    expect(loadAudioVolume(store)).toBe(1);
    saveAudioVolume(store, Number.NaN);
    expect(loadAudioVolume(store)).toBe(1);

    expect(loadAudioVolume(null)).toBe(1);
    const refusing: ModeStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadAudioVolume(refusing)).toBe(1);
    expect(() => saveAudioVolume(refusing, 0.5)).not.toThrow();
    expect(() => saveAudioVolume(null, 0.5)).not.toThrow();
  });
});

describe("where a seek lands (#343)", () => {
  it("never at the exact end, which asks the server for bytes past the last one", () => {
    expect(seekTarget(4, 4)).toBeCloseTo(4 - END_MARGIN, 10);
    expect(seekTarget(9, 4)).toBeCloseTo(4 - END_MARGIN, 10);
    expect(seekTarget(4 - END_MARGIN / 2, 4)).toBeCloseTo(4 - END_MARGIN, 10);
  });
  it("anywhere else, exactly where it was asked", () => {
    expect(seekTarget(3.5, 4)).toBe(3.5);
    expect(seekTarget(0, 4)).toBe(0);
    expect(seekTarget(-1, 4)).toBe(0);
  });
  it("still reads as the end, where a seek to the end lands", () => {
    expect(timeText(seekTarget(4, 4), 4)).toBe("0:04 / 0:04");
    expect(timeWords(seekTarget(4, 4), 4)).toBe("0:04 of 0:04");
    expect(timeText(3.9, 4)).toBe("0:03 / 0:04");
  });
  it("as asked while the length isn't known, and never below the start", () => {
    expect(seekTarget(2, Number.NaN)).toBe(2);
    expect(seekTarget(2, Number.POSITIVE_INFINITY)).toBe(2);
    expect(seekTarget(0.03, 0.02)).toBe(0);
  });
});

describe("the timeline", () => {
  it("knows a length only when there is one", () => {
    expect(knownSeconds(3.5)).toBe(3.5);
    for (const unknown of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(knownSeconds(unknown)).toBeNull();
  });

  it("moves a second per key, or a tenth of one in a clip under a minute", () => {
    expect(seekStep(null)).toBe(0.1);
    expect(seekStep(4)).toBe(0.1);
    expect(seekStep(59.9)).toBe(0.1);
    expect(seekStep(60)).toBe(1);
    expect(seekStep(3725)).toBe(1);
  });

  it("puts a position on those steps, inside the file", () => {
    expect(onStep(0.34, 4)).toBe(0.3);
    expect(onStep(0.36, 4)).toBe(0.4);
    expect(onStep(3.99, 4)).toBe(4);
    expect(onStep(12.6, 225)).toBe(13);
    expect(onStep(225, 224.6)).toBe(224.6);
    expect(onStep(-2, 225)).toBe(0);
    expect(onStep(1.26, null)).toBe(1.3);
  });
});

describe("the time it says", () => {
  it("counts whole seconds gone by, against the length", () => {
    expect(timeText(0, 225)).toBe("0:00 / 3:45");
    expect(timeText(12.9, 225)).toBe("0:12 / 3:45");
    expect(timeText(3.6, 4)).toBe("0:03 / 0:04");
    expect(timeText(125, 3725)).toBe("2:05 / 1:02:05");
  });

  it("reaches the length at the end, however the length was rounded", () => {
    expect(timeText(3.6, 3.6)).toBe("0:04 / 0:04");
    expect(timeText(9, 3.6)).toBe("0:04 / 0:04");
  });

  it("says just the position while the length isn't known", () => {
    expect(timeText(0, null)).toBe("0:00");
    expect(timeText(61.2, null)).toBe("1:01");
  });

  it("reserves room for the widest it will get", () => {
    expect(timeSizer(225)).toBe("3:45 / 3:45");
    expect(timeSizer(3725)).toBe("1:02:05 / 1:02:05");
    expect(timeSizer(null)).toBe("0:00");
    for (const at of [0, 9.5, 59, 600, 3599, 3725]) expect(timeText(at, 3725).length).toBeLessThanOrEqual(timeSizer(3725).length);
  });

  it("reads out as a position of a length", () => {
    expect(timeWords(12.9, 225)).toBe("0:12 of 3:45");
    expect(timeWords(12.9, null)).toBe("0:12");
  });
});
