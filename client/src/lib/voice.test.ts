import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampVolume,
  PICK_A_DEVICE,
  startProblemWords,
  voiceStartProblem,
  DEFAULT_VOICE_PREFS,
  loadVoicePrefs,
  microphoneLine,
  saveVoicePrefs,
  volumeLabel,
} from "./voice";

describe("the microphone line", () => {
  it("says what is happening only when a button cannot", () => {
    expect(microphoneLine("opening", false)).toMatch(/opening/);
    expect(microphoneLine("opening", true)).toMatch(/opening/);
    expect(microphoneLine("sending", false)).toBeNull();
    expect(microphoneLine("sending", true)).toMatch(/hold control to talk/);
    expect(microphoneLine("sending", true, "Right Ctrl")).toBe("hold Right Ctrl to talk");
    expect(microphoneLine("stopped", true)).toMatch(/stopped/);
    expect(microphoneLine("encoder: boom", false)).toMatch(/could not start/);
  });
});

describe("volume", () => {
  it("labels as a percentage of as-sent", () => {
    expect(volumeLabel(1)).toBe("100%");
    expect(volumeLabel(0.5)).toBe("50%");
    expect(volumeLabel(2)).toBe("200%");
  });

  it("clamps to what the core accepts", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(3)).toBe(2);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(1.25)).toBe(1.25);
  });
});

describe("preferences", () => {
  // The tests run in node, which has no `window`. Enough of one for the
  // preferences: a storage that remembers within a test and not across.
  beforeEach(() => {
    const held = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key),
      },
    });
    return () => vi.unstubAllGlobals();
  });

  it("default to the system devices and an open microphone", () => {
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
  });

  it("round-trip, and forget a device set back to the default", () => {
    saveVoicePrefs({ devices: { input: "USB Mic", output: null }, pushToTalk: true, forwarding: true, pushToTalkKey: "AltRight" });
    expect(loadVoicePrefs()).toEqual({
      devices: { input: "USB Mic", output: null },
      pushToTalk: true,
      forwarding: true,
      pushToTalkKey: "AltRight",
    });
    saveVoicePrefs({ devices: { input: null, output: "Headphones" }, pushToTalk: false, forwarding: false, pushToTalkKey: "ControlRight" });
    expect(loadVoicePrefs()).toEqual({
      devices: { input: null, output: "Headphones" },
      pushToTalk: false,
      forwarding: false,
      pushToTalkKey: "ControlRight",
    });
  });

  it("go through the server unless somebody chose the old way (#197)", () => {
    expect(loadVoicePrefs().forwarding).toBe(true);
    window.localStorage.setItem("linger.voice.forwarding", "false");
    expect(loadVoicePrefs().forwarding).toBe(false);
    window.localStorage.setItem("linger.voice.forwarding", "anything else");
    expect(loadVoicePrefs().forwarding).toBe(true);
  });
});

describe("voiceStartProblem (#261)", () => {
  const byDefault = { input: null, output: null };
  const byName = { input: "USB Microphone", output: "Headphones" };

  it.each([
    ["the microphone wouldn't open: no input device", false, "No microphone found. Plug one in, or pick one in Settings."],
    ["the speakers wouldn't open: no output device", false, "No speakers found. Plug some in, or pick them in Settings."],
    ["the microphone wouldn't open: Permission denied. Grant the required access and retry.", true, "Windows' privacy settings are blocking the microphone."],
    ["the microphone wouldn't open: Permission denied. Grant the required access and retry.", false, "Linger isn't allowed to use the microphone."],
    ["the speakers wouldn't open: Permission denied.", true, "Linger isn't allowed to use the speakers."],
    ["the microphone wouldn't open: The requested device is temporarily busy.", false, "The microphone is in use by another app."],
    ["the speakers wouldn't open: The requested device is temporarily busy.", false, "The speakers are in use by another app."],
    ["Voice only works in the desktop app.", false, "Voice only works in the desktop app."],
    ["Not connected yet.", false, "Something went wrong. Try again."],
  ])("%s (windows: %s)", (problem, windows, line) => {
    // These don't depend on which device was asked for, and name no fix of their own (#273).
    for (const asked of [byDefault, byName]) {
      expect(voiceStartProblem(problem, windows, asked)).toEqual({ line, fix: null });
    }
  });

  // What fixes a device that won't open depends on which one was asked for (#273).
  describe("a device that wouldn't open (#273)", () => {
    const microphone = "the microphone wouldn't open: The requested device could not be opened.";
    const speakers = "the speakers wouldn't open: The requested device could not be opened.";

    it.each([
      ["the system default, on Windows", microphone, true, byDefault, "Windows' default microphone wouldn't open. Pick yours in Settings."],
      ["the system default, on Windows", speakers, true, byDefault, "Windows' default speakers wouldn't open. Pick yours in Settings."],
      ["the system default, elsewhere", microphone, false, byDefault, "The default microphone wouldn't open. Pick yours in Settings."],
      ["the system default, elsewhere", speakers, false, byDefault, "The default speakers wouldn't open. Pick yours in Settings."],
      ["picked by name, on Windows", microphone, true, byName, "The microphone wouldn't open."],
      ["picked by name, on Windows", speakers, true, byName, "The speakers wouldn't open."],
      ["picked by name, elsewhere", microphone, false, byName, "The microphone wouldn't open."],
      ["picked by name, elsewhere", speakers, false, byName, "The speakers wouldn't open."],
    ])("%s: %s", (_, problem, windows, asked, words) => {
      expect(startProblemWords(voiceStartProblem(problem, windows, asked))).toBe(words);
    });

    it("keeps the fix apart, for the strip to keep whole", () => {
      expect(voiceStartProblem(microphone, true, byDefault)).toEqual({ line: "Windows' default microphone wouldn't open.", fix: PICK_A_DEVICE });
      expect(voiceStartProblem(microphone, true, byName)).toEqual({ line: "The microphone wouldn't open.", fix: null });
    });

    it("looks at the choice for the device that failed, not the other one", () => {
      const micByName = { input: "USB Microphone", output: null };
      expect(voiceStartProblem(microphone, false, micByName).fix).toBeNull();
      expect(voiceStartProblem(speakers, false, micByName).fix).toBe(PICK_A_DEVICE);
      const speakersByName = { input: null, output: "Headphones" };
      expect(voiceStartProblem(microphone, false, speakersByName).fix).toBe(PICK_A_DEVICE);
      expect(voiceStartProblem(speakers, false, speakersByName).fix).toBeNull();
    });

    it("a format the shell can't read is a device that wouldn't open", () => {
      const format = "the microphone wouldn't open: the input device produces dsdu8 samples, which this build cannot read";
      expect(startProblemWords(voiceStartProblem(format, false, byDefault))).toBe("The default microphone wouldn't open. Pick yours in Settings.");
      expect(startProblemWords(voiceStartProblem(format, false, byName))).toBe("The microphone wouldn't open.");
    });
  });
});
