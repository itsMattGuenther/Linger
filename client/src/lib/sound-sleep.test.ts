/**
 * A window's audio is open only around its sounds (#531). A running
 * `AudioContext` holds an output stream open, playing silence, which cost
 * 2–5% of a core per window that had been clicked, all day. In the desktop
 * app the shell plays Linger's sounds (#250), so a click opens nothing; the
 * page's audio is opened for a sound the shell couldn't play, and closed once
 * no sound has played for the shell's own `KEEP_OPEN`. Closed, not suspended:
 * the packaged WebKitGTK plays nothing after a resume.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chimes", () => ({ renderChime: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderChime } from "./chimes";

const WAVE = new Float32Array([0, 0.5, -0.5, 0]);
const rendered = { getChannelData: () => WAVE } as unknown as AudioBuffer;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(renderChime).mockReset().mockResolvedValue(rendered);
  // The shell refuses: every sound falls back to the page's own audio.
  vi.mocked(invoke).mockReset().mockResolvedValue(false);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 10, 12));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The window's audio devices: every context made, its state, and the state
 * it was in when each sound started. A new one starts suspended, as a
 * browser makes one before a click; `resume` and `close` land at once.
 */
function speakers({ refuse = () => false }: { refuse?: () => boolean } = {}) {
  const made: { state: AudioContextState; started: AudioContextState[] }[] = [];
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => undefined },
    AudioContext: class {
      sampleRate = 48000;
      destination = {};
      state: AudioContextState = "suspended";
      started: AudioContextState[] = [];
      constructor() { made.push(this); }
      resume() {
        if (refuse()) return Promise.reject(new Error("not allowed"));
        this.state = "running";
        return Promise.resolve();
      }
      close() {
        this.state = "closed";
        return Promise.resolve();
      }
      createBufferSource() {
        return { buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(() => this.started.push(this.state)) };
      }
    },
  });
  return {
    made,
    /** How many are open (not closed) right now. */
    open: () => made.filter((one) => one.state !== "closed").length,
    states: () => made.map((one) => one.state),
  };
}

it("closes after the same quiet as the shell's own speaker, read from sounds.rs", async () => {
  const sound = await import("./sound");
  const shell = readFileSync(new URL("../../src-tauri/src/sounds.rs", import.meta.url), "utf8");
  expect(shell).toContain(`pub const KEEP_OPEN: Duration = Duration::from_secs(${sound.AUDIO_KEEP_OPEN_MS / 1000});`);
});

describe("in the desktop app, where the shell plays Linger's sounds", () => {
  it("the first click opens nothing", async () => {
    const device = speakers();
    const sound = await import("./sound");
    await expect(sound.unlockAudio()).resolves.toBe(true);
    expect(device.made).toHaveLength(0);
  });

  it("a sound the shell plays never opens the page's audio", async () => {
    const device = speakers();
    vi.mocked(invoke).mockResolvedValue(true);
    const sound = await import("./sound");
    await sound.unlockAudio();
    await expect(sound.playSound("dm")).resolves.toBe(true);
    await expect(sound.playKnock()).resolves.toBe(true);
    expect(device.made).toHaveLength(0);
  });

  it("a sound the shell refused opens it, with no click, and it closes after the shell's keep-open time", async () => {
    const device = speakers();
    const sound = await import("./sound");
    await expect(sound.playSound("dm")).resolves.toBe(true);
    expect(device.made.map((one) => one.started)).toEqual([["running"]]);
    await vi.advanceTimersByTimeAsync(sound.AUDIO_KEEP_OPEN_MS - 1);
    expect(device.open()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(device.states()).toEqual(["closed"]);
    // An hour later the first sound after the quiet still plays, on a new one.
    await vi.advanceTimersByTimeAsync(HOUR);
    await expect(sound.playKnock()).resolves.toBe(true);
    expect(device.made.map((one) => one.started)).toEqual([["running"], ["running"]]);
    expect(device.states()).toEqual(["closed", "running"]);
  });
});

describe("outside the app, where the page's audio is the player", () => {
  beforeEach(() => vi.mocked(isTauri).mockReturnValue(false));

  it("the first click opens the audio inside the gesture, and a click with no sound after it keeps it only for the keep-open time", async () => {
    const device = speakers();
    const sound = await import("./sound");
    // Before any click, a live sound can't open it: a browser would refuse.
    await expect(sound.playSound("dm")).resolves.toBe(false);
    expect(device.made).toHaveLength(0);
    await expect(sound.unlockAudio()).resolves.toBe(true);
    expect(device.states()).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.states()).toEqual(["closed"]);
    // After that click, a live sound opens a new one itself.
    await vi.advanceTimersByTimeAsync(HOUR);
    await expect(sound.playSound("dm")).resolves.toBe(true);
    expect(device.states()).toEqual(["closed", "running"]);
  });

  it("a burst keeps it open, and it closes the keep-open time after the last sound", async () => {
    const device = speakers();
    const sound = await import("./sound");
    await sound.unlockAudio();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(sound.AUDIO_KEEP_OPEN_MS - 1000);
      await expect(sound.playSound("dm")).resolves.toBe(true);
    }
    expect(device.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(sound.AUDIO_KEEP_OPEN_MS - 1);
    expect(device.states()).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(device.states()).toEqual(["closed"]);
  });

  it("never closes under a sound being made, and never has two open", async () => {
    const device = speakers();
    let finish: (buffer: AudioBuffer) => void = () => undefined;
    vi.mocked(renderChime).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const sound = await import("./sound");
    await sound.unlockAudio();
    const playing = sound.playPreview("knock");
    await vi.advanceTimersByTimeAsync(sound.AUDIO_KEEP_OPEN_MS * 2);
    expect(device.states()).toEqual(["running"]);
    finish(rendered);
    await expect(playing).resolves.toBe(true);
    await expect(sound.playPreview("dm")).resolves.toBe(true);
    expect(device.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(sound.AUDIO_KEEP_OPEN_MS);
    expect(device.open()).toBe(0);
  });
});

describe("the first click or key in a window", () => {
  it("in the app, stops listening at once", async () => {
    const device = speakers();
    const sound = await import("./sound");
    const target = new EventTarget();
    const removed = vi.spyOn(target, "removeEventListener");
    sound.unlockAudioOnGesture(target);
    target.dispatchEvent(new Event("keydown"));
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(2));
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown"]);
    expect(device.made).toHaveLength(0);
  });

  it("outside the app, keeps listening while the device refuses, so the next click can try again", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    let refuse = true;
    const device = speakers({ refuse: () => refuse });
    const sound = await import("./sound");
    const target = new EventTarget();
    const removed = vi.spyOn(target, "removeEventListener");
    sound.unlockAudioOnGesture(target);
    target.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).not.toHaveBeenCalled();
    refuse = false;
    target.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(2));
    expect(device.states()).toEqual(["running"]);
  });
});
