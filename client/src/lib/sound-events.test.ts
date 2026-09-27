import { describe, expect, it } from "vitest";
import type { MyVoice } from "./gateway";
import { controlCue } from "./sound-events";

function seat(changes: Partial<MyVoice> = {}): MyVoice {
  return {
    roomId: "r-garage",
    muted: false,
    deafened: false,
    mutedBeforeDeafen: false,
    pushToTalk: false,
    talkHeld: false,
    moved: false,
    audio: "sending",
    peers: {},
    speaking: {},
    talking: false,
    volumes: {},
    ...changes,
  };
}

describe("the sound that confirms your own mute or deafen", () => {
  it("says what the microphone did", () => {
    expect(controlCue(seat(), seat({ muted: true }))).toBe("mute");
    expect(controlCue(seat({ muted: true }), seat())).toBe("unmute");
  });

  it("says deafen, whatever deafening did to the microphone with it", () => {
    expect(controlCue(seat(), seat({ deafened: true, muted: true }))).toBe("deafen");
    expect(controlCue(seat({ deafened: true, muted: true }), seat())).toBe("undeafen");
    expect(controlCue(seat({ pushToTalk: true, talkHeld: true }), seat({ pushToTalk: true, muted: true, deafened: true }))).toBe("deafen");
  });

  it("sounds for a Mute you choose under push-to-talk: it's a real mute (#232)", () => {
    expect(controlCue(seat({ pushToTalk: true }), seat({ pushToTalk: true, muted: true }))).toBe("mute");
    expect(controlCue(seat({ pushToTalk: true, muted: true }), seat({ pushToTalk: true }))).toBe("unmute");
  });

  it("is silent for push-to-talk's key, for turning push-to-talk on or off, and when nothing changed", () => {
    expect(controlCue(seat({ pushToTalk: true }), seat({ pushToTalk: true, talkHeld: true }))).toBeNull();
    expect(controlCue(seat({ pushToTalk: true, talkHeld: true }), seat({ pushToTalk: true }))).toBeNull();
    expect(controlCue(seat(), seat({ pushToTalk: true }))).toBeNull();
    expect(controlCue(seat({ pushToTalk: true, muted: true }), seat({ muted: true }))).toBeNull();
    expect(controlCue(seat(), seat())).toBeNull();
    expect(controlCue(seat({ muted: true }), seat({ muted: true, talking: true }))).toBeNull();
  });
});
