import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chimes", () => ({ renderChime: vi.fn() }));
import { renderChime } from "./chimes";
const rendered = {} as AudioBuffer;

beforeEach(() => { vi.resetModules(); vi.mocked(renderChime).mockReset().mockResolvedValue(rendered); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 17, 12)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function storage(held = new Map<string, string>()) {
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => { held.set(key, value); } };
}

function player() {
  const sources: { buffer: AudioBuffer | null; onended: (() => void) | null; start: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const device = { state: "running" as AudioContextState };
  vi.stubGlobal("window", { localStorage: storage(), AudioContext: class {
    sampleRate = 48000;
    destination = {};
    get state() { return device.state; }
    createBufferSource() {
      const source = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }
  } });
  return { sources, device };
}

describe("notification sound policy", () => {
  it("shares preparation across previews, reuses the waveform and disconnects completed sources", async () => {
    const { sources } = player();
    const sound = await import("./sound");
    expect(await Promise.all([sound.playPreview("dm"), sound.playPreview("dm")])).toEqual([true, true]);
    await expect(sound.playPreview("dm")).resolves.toBe(true);
    expect(renderChime).toHaveBeenCalledExactlyOnceWith("dm", 48000);
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      expect(source.buffer).toBe(rendered);
      expect(source.start).toHaveBeenCalledOnce();
      source.onended?.();
      expect(source.disconnect).toHaveBeenCalledOnce();
    }
  });

  it.each(["mute", "stale", "suspended"] as const)("drops a live cue when %s changes during preparation", async (change) => {
    const { sources, device } = player();
    let finish: (buffer: AudioBuffer) => void = () => {};
    vi.mocked(renderChime).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const sound = await import("./sound");
    sound.unlockAudio();
    const playing = sound.playSound("dm");
    if (change === "mute") sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, muted: true });
    if (change === "stale") vi.advanceTimersByTime(1100);
    if (change === "suspended") device.state = "suspended";
    finish(rendered);
    await expect(playing).resolves.toBe(false);
    expect(sources).toHaveLength(0);
  });

  it("a failed render is retried without consuming the live burst allowance", async () => {
    player();
    vi.mocked(renderChime).mockRejectedValueOnce(new Error("render refused"));
    const sound = await import("./sound");
    sound.unlockAudio();
    await expect(sound.playSound("dm")).resolves.toBe(false);
    await expect(sound.playSound("dm")).resolves.toBe(true);
    expect(renderChime).toHaveBeenCalledTimes(2);
  });

  it("uses quiet defaults, preserves old master/quiet preferences and validates categories", async () => {
    const held = new Map([["linger.sound.muted", "true"], ["linger.sound.categories", '{"rooms":true,"voice":"no"}']]);
    vi.stubGlobal("window", { localStorage: storage(held) });
    const sound = await import("./sound");
    const prefs = sound.loadSoundPrefs();
    expect(prefs).toEqual({ muted: true, quietHours: false, quietFrom: 22 * 60, quietUntil: 8 * 60, categories: { voice: true, controls: true, dms: true, rooms: true, knocks: true, door: false } });
    held.set("linger.sound.quietHours", "true");
    expect(sound.loadSoundPrefs().quietHours).toBe(true);
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

  it("remembers a moved quiet window and ignores a damaged one (#185)", async () => {
    const held = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage(held) });
    const sound = await import("./sound");
    sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, quietHours: true, quietFrom: 21 * 60, quietUntil: 6 * 60 });
    expect(held.get("linger.sound.quietFrom")).toBe(String(21 * 60));
    const loaded = sound.loadSoundPrefs();
    expect([loaded.quietFrom, loaded.quietUntil]).toEqual([21 * 60, 6 * 60]);
    for (const bad of ["", "-30", "1440", "9.5", "nine"]) {
      held.set("linger.sound.quietFrom", bad);
      expect(sound.loadSoundPrefs().quietFrom).toBe(sound.DEFAULT_QUIET_FROM);
    }
  });

  it("master mute wins over every category", async () => {
    const sound = await import("./sound");
    for (const cue of ["voice-join", "voice-move", "peer-leave", "mute", "deafen", "dm", "room", "knock", "door"] as const) {
      const prefs = { ...sound.DEFAULT_SOUND_PREFS, muted: true, categories: { voice: true, controls: true, dms: true, rooms: true, knocks: true, door: true } };
      expect(sound.cueAllowed(cue, prefs, new Date(2026, 8, 17, 14))).toBe(false);
      expect(sound.cueAllowed(cue, prefs, new Date(2026, 8, 17, 3))).toBe(false);
    }
  });

  it("quiet hours silence notifications, not the controls of a call you are in (#186)", async () => {
    const sound = await import("./sound");
    const prefs = { ...sound.DEFAULT_SOUND_PREFS, quietHours: true, categories: { voice: true, controls: true, dms: true, rooms: true, knocks: true, door: true } };
    const night = new Date(2026, 8, 17, 3);
    for (const cue of ["dm", "room", "knock", "door"] as const) {
      expect(sound.cueAllowed(cue, prefs, night)).toBe(false);
      expect(sound.cueAllowed(cue, prefs, new Date(2026, 8, 17, 14))).toBe(true);
    }
    for (const cue of ["mute", "unmute", "deafen", "undeafen", "voice-join", "voice-leave", "voice-move", "peer-join", "peer-leave"] as const) {
      expect(sound.cueAllowed(cue, prefs, night)).toBe(true);
    }
    // Their own switches still silence them.
    expect(sound.cueAllowed("mute", { ...prefs, categories: { ...prefs.categories, controls: false } }, night)).toBe(false);
    expect(sound.cueAllowed("voice-join", { ...prefs, categories: { ...prefs.categories, voice: false } }, night)).toBe(false);
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
      createBufferSource() { return { ...node }; }
    } });
    const sound = await import("./sound");
    sound.unlockAudio();
    await expect(sound.playSound("dm")).resolves.toBe(false);
    resume = async () => { vi.advanceTimersByTime(1100); };
    await expect(sound.playSound("dm")).resolves.toBe(false);
    expect(starts).toHaveLength(0);
    resume = async () => {};
    const results = await Promise.all([sound.playSound("dm"), sound.playSound("dm")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(starts).toHaveLength(1);
    vi.advanceTimersByTime(1200);
    await expect(sound.playSound("dm")).resolves.toBe(true);
  });

  it("Listen previews play during quiet hours and master silence", async () => {
    const starts: number[] = [];
    const param = { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    const node = { connect: () => node, disconnect: () => {}, gain: param, frequency: param, start: (at: number) => starts.push(at), stop: () => {} };
    vi.stubGlobal("window", { localStorage: storage(), AudioContext: class {
      state = "running"; currentTime = 0; destination = {};
      async resume() {}
      createBufferSource() { return { ...node }; }
    } });
    vi.setSystemTime(new Date(2026, 8, 17, 3));
    const sound = await import("./sound");
    sound.saveSoundPrefs({ ...sound.DEFAULT_SOUND_PREFS, muted: true });
    expect(sound.cueAllowed("mute", sound.loadSoundPrefs(), new Date())).toBe(false);
    await expect(sound.playSound("mute")).resolves.toBe(false);
    await expect(sound.playPreview("mute")).resolves.toBe(true);
    expect(starts.length).toBeGreaterThan(0);
  });
});
