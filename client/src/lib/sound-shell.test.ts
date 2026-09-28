/**
 * Linger's sounds in the desktop app go to the shell, which plays them on the
 * Speakers picked in Settings (#250). Outside the app, or when the shell
 * can't, they play through Web Audio as before (sound-player.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chimes", () => ({ renderChime: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderChime } from "./chimes";

/** A rendered cue: four samples, the loudest at full scale. */
const WAVE = new Float32Array([0, 0.5, -1, 0.25]);

beforeEach(() => {
  vi.resetModules();
  vi.mocked(renderChime).mockReset().mockResolvedValue({ getChannelData: () => WAVE } as unknown as AudioBuffer);
  vi.mocked(invoke).mockReset().mockResolvedValue(true);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 17, 12));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function desktop(held = new Map<string, string>()) {
  const sources: unknown[] = [];
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) },
    AudioContext: class {
      sampleRate = 48000;
      destination = {};
      state = "running";
      createBufferSource() {
        const source = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), disconnect: vi.fn() };
        sources.push(source);
        return source;
      }
    },
  });
  return { held, sources };
}

const played = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "sound_play").map(([, args]) => args);

describe("sounds on the chosen speakers (#250)", () => {
  it("hands the shell the cue's samples at the sound volume, and the Speakers picked", async () => {
    const { held, sources } = desktop(new Map([["linger.voice.output", "USB Audio"], ["linger.sound.volume", "2"]]));
    const sound = await import("./sound");
    await expect(sound.playSound("dm")).resolves.toBe(true);
    expect(renderChime).toHaveBeenCalledExactlyOnceWith("dm", 48000, 2);
    expect(played()).toEqual([{ samples: [0, 16384, -32767, 8192], output: "USB Audio" }]);
    expect(sources).toHaveLength(0);

    // Settings picks the system default: the next sound follows.
    held.delete("linger.voice.output");
    vi.advanceTimersByTime(2000);
    await expect(sound.playPreview("knock")).resolves.toBe(true);
    expect(played()[1]).toMatchObject({ output: null });
  });

  it("plays through Web Audio when the shell couldn't", async () => {
    const { sources } = desktop();
    vi.mocked(invoke).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("no shell"));
    const sound = await import("./sound");
    await expect(sound.playPreview("dm")).resolves.toBe(true);
    await expect(sound.playPreview("dm")).resolves.toBe(true);
    expect(played()).toHaveLength(2);
    expect(sources).toHaveLength(2);
  });

  it("doesn't reach the shell for a cue that is off, or muted while it was being made", async () => {
    desktop(new Map([["linger.sound.categories", JSON.stringify({ dms: false })]]));
    const sound = await import("./sound");
    await expect(sound.playSound("dm")).resolves.toBe(false);
    expect(renderChime).not.toHaveBeenCalled();

    let finish: (buffer: AudioBuffer) => void = () => undefined;
    vi.mocked(renderChime).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const playing = sound.playSound("knock");
    sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, muted: true });
    finish({ getChannelData: () => WAVE } as unknown as AudioBuffer);
    await expect(playing).resolves.toBe(false);
    expect(played()).toEqual([]);
  });

  it("keeps the rendered samples for the next cue, and renders again at a new volume", async () => {
    const { held } = desktop();
    const sound = await import("./sound");
    await sound.playPreview("dm");
    await sound.playPreview("dm");
    expect(renderChime).toHaveBeenCalledTimes(1);
    held.set("linger.sound.volume", "0.5");
    await sound.playPreview("dm");
    expect(renderChime).toHaveBeenLastCalledWith("dm", 48000, 0.5);
  });

  it("outside the desktop app, never asks for the shell", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const { sources } = desktop();
    const sound = await import("./sound");
    await expect(sound.playPreview("dm")).resolves.toBe(true);
    expect(played()).toEqual([]);
    expect(sources).toHaveLength(1);
  });
});
