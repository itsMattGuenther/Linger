import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "../generated/User";
import type { VoicePeer } from "../generated/VoicePeer";
import {
  clampVolume,
  PICK_A_DEVICE,
  startProblemWords,
  voiceStartProblem,
  DEFAULT_VOICE_PREFS,
  loadVoicePrefs,
  microphoneLine,
  saveVoicePrefs,
  seatsOf,
  usersInVoice,
  volumeLabel,
  withMySeat,
} from "./voice";

function person(id: string, name: string): User {
  return {
    id,
    username: name,
    display_name: name,
    is_host: false,
    style: {
      font_key: "inter",
      weight: 400,
      italic: false,
      fill: { kind: "solid", color: "azure" },
      effect: "none",
      msg_font_key: null,
    },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function seat(session: string, user: string): VoicePeer {
  return { session_id: session, user_id: user };
}

describe("seats in the bar", () => {
  const users = [person("u-zed", "zed"), person("u-amy", "amy")];

  it("puts you first and the rest by name", () => {
    const seats = seatsOf(
      [seat("s-3", "u-zed"), seat("s-1", "u-amy"), seat("s-2", "u-zed")],
      users,
      "s-2",
    );
    expect(seats.map((s) => [s.sessionId, s.name, s.isMe])).toEqual([
      ["s-2", "zed", true],
      ["s-1", "amy", false],
      ["s-3", "zed", false],
    ]);
  });

  it("draws two sessions of one person as two seats", () => {
    const seats = seatsOf([seat("s-a", "u-amy"), seat("s-b", "u-amy")], users, null);
    expect(seats).toHaveLength(2);
    expect(seats.every((s) => s.user?.id === "u-amy")).toBe(true);
  });

  it("names a stranger 'somebody' rather than dropping the seat", () => {
    const seats = seatsOf([seat("s-x", "u-nobody")], users, null);
    expect(seats).toHaveLength(1);
    expect(seats[0]?.user).toBeUndefined();
    expect(seats[0]?.name).toBe("somebody");
  });
});

describe("your own seat follows what you did (#141)", () => {
  const controls = { muted: false, deafened: false };
  const me = { userId: "u-me", controls };

  it("adds you before the server has listed you", () => {
    expect(withMySeat([seat("s-1", "u-amy")], "s-me", me)).toEqual([
      seat("s-1", "u-amy"),
      { session_id: "s-me", user_id: "u-me", controls },
    ]);
  });

  it("uses the server's seat once it lists you, never a second one", () => {
    const listed = [seat("s-me", "u-me"), seat("s-1", "u-amy")];
    expect(withMySeat(listed, "s-me", me)).toBe(listed);
  });

  it("drops you as soon as you leave, while the server still lists you", () => {
    expect(withMySeat([seat("s-me", "u-me"), seat("s-1", "u-amy")], "s-me", null)).toEqual([
      seat("s-1", "u-amy"),
    ]);
  });

  it("keeps your other devices, which are other sessions", () => {
    const peers = [seat("s-laptop", "u-me"), seat("s-1", "u-amy")];
    expect(withMySeat(peers, "s-me", null)).toBe(peers);
  });

  it("leaves the list alone before you are connected", () => {
    const peers = [seat("s-1", "u-amy")];
    expect(withMySeat(peers, null, me)).toBe(peers);
  });
});

describe("who is in voice anywhere", () => {
  it("is the union across rooms, by person", () => {
    const set = usersInVoice({
      "r-1": [seat("s-1", "u-amy"), seat("s-2", "u-amy")],
      "r-2": [seat("s-3", "u-zed")],
    });
    expect([...set].sort()).toEqual(["u-amy", "u-zed"]);
  });

  it("is empty when nobody is", () => {
    expect(usersInVoice({}).size).toBe(0);
  });
});

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
