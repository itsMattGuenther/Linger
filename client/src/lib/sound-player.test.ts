import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 17, 12)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function storage(held = new Map<string, string>()) {
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => { held.set(key, value); } };
}

describe("notification sound policy", () => {
  it("uses quiet defaults, preserves old master/quiet preferences and validates categories", async () => {
    const held = new Map([["linger.sound.muted", "true"], ["linger.sound.categories", '{"rooms":true,"voice":"no"}']]);
    vi.stubGlobal("window", { localStorage: storage(held) });
    const sound = await import("./sound");
    const prefs = sound.loadSoundPrefs();
    expect(prefs).toEqual({ muted: true, quietHours: true, categories: { voice: true, controls: true, dms: true, rooms: true, knocks: true } });
    sound.saveSoundPrefs({ ...prefs, muted: false, categories: { ...prefs.categories, rooms: false } });
    expect(sound.loadSoundPrefs().categories.rooms).toBe(false);
    expect(sound.cueAllowed("dm", sound.loadSoundPrefs(), new Date())).toBe(true);
    expect(sound.cueAllowed("room", sound.loadSoundPrefs(), new Date())).toBe(false);
    held.set("linger.sound.categories", "broken");
    expect(sound.loadSoundPrefs().categories).toEqual(sound.DEFAULT_SOUND_PREFS.categories);
  });

  it("keeps changes for this run if storage refuses", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } } });
    const sound = await import("./sound");
    expect(sound.loadSoundPrefs()).toEqual(sound.DEFAULT_SOUND_PREFS);
    sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, muted: true });
    expect(sound.loadSoundPrefs().muted).toBe(true);
  });

  it("master mute and quiet hours win over every category", async () => {
    const sound = await import("./sound");
    for (const cue of ["voice-join", "voice-move", "peer-leave", "mute", "deafen", "dm", "room", "knock"] as const) {
      const prefs = { ...sound.DEFAULT_SOUND_PREFS, categories: { voice: true, controls: true, dms: true, rooms: true, knocks: true } };
      expect(sound.cueAllowed(cue, prefs, new Date(2026, 8, 17, 3))).toBe(false);
      expect(sound.cueAllowed(cue, { ...prefs, muted: true }, new Date())).toBe(false);
    }
  });

  it("keeps master silence when storage can be read but writes fail", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
    const sound = await import("./sound");
    sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, muted: true });
    expect(sound.loadSoundPrefs().muted).toBe(true);
    await expect(sound.playSound("dm")).resolves.toBe(false);
  });

  it("refusing AudioContext construction never loses the event or throws", async () => {
    vi.stubGlobal("window", { localStorage: storage(), AudioContext: class { constructor() { throw new Error("no audio"); } } });
    const sound = await import("./sound");
    await expect(sound.playSound("dm")).resolves.toBe(false);
  });

  it("catches resume failure, drops stale cues and batches a burst", async () => {
    const starts: number[] = [];
    let resume: () => Promise<void> = async () => { throw new Error("refused"); };
    const param = { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    const node = { connect: () => node, disconnect: () => {}, gain: param, frequency: param, start: (at: number) => starts.push(at), stop: () => {} };
    vi.stubGlobal("window", { localStorage: storage(), AudioContext: class {
      state = "suspended"; currentTime = 0; destination = {};
      async resume() { await resume(); this.state = "running"; }
      createGain() { return node; }
      createOscillator() { return { ...node }; }
    } });
    const sound = await import("./sound");
    await expect(sound.playSound("dm")).resolves.toBe(false);
    resume = async () => { vi.advanceTimersByTime(1100); };
    await expect(sound.playSound("dm")).resolves.toBe(false);
    expect(starts).toHaveLength(0);
    resume = async () => {};
    const results = await Promise.all([sound.playSound("dm"), sound.playSound("dm")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(starts).toHaveLength(4);
    vi.advanceTimersByTime(1200);
    await expect(sound.playSound("dm")).resolves.toBe(true);
  });
});
