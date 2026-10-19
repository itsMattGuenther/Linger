import { describe, expect, it } from "vitest";

import { Gate, HANGOVER_MS, iceUfrag, microphoneMid, microphoneProblem, mids, TALKING_LEVEL, withQuietSilence } from "./pageVoice";
import { voiceStartProblem } from "./voice";

// The phone's voice engine (#429). The connection itself is proven in a real
// browser (tests/browser/next-phone-voice-room.spec.ts); these are the rules
// around it, which must match the desktop engine's.

/** An offer the way the forwarding server shapes one: the microphone's m-line first, then a voice. */
const OFFER = [
  "v=0",
  "o=- 1 1 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=ice-ufrag:aaaa",
  "a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbbbb",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=recvonly",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=sendonly",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

describe("reading the server's offer", () => {
  it("finds every m-line, and the microphone's as the one the tracks don't name", () => {
    expect(mids(OFFER)).toEqual(["0", "1"]);
    expect(microphoneMid(OFFER, [{ mid: "1", session_id: "s-eli" }])).toBe("0");
    expect(microphoneMid(OFFER, [{ mid: "0", session_id: "s-eli" }, { mid: "1", session_id: "s-jules" }])).toBeNull();
  });

  it("reads the ICE username fragment that tells a fresh connection from the same one (#656)", () => {
    expect(iceUfrag(OFFER)).toBe("aaaa");
    expect(iceUfrag(OFFER.replace("a=ice-ufrag:aaaa", "a=ice-ufrag:cccc"))).toBe("cccc");
    expect(iceUfrag("v=0\r\n")).toBeNull();
  });
});

describe("silence on the phone's microphone (#197)", () => {
  it("asks Opus to stop sending in silence on the microphone's m-line only", () => {
    const quiet = withQuietSilence(OFFER, "0");
    const [, mine, theirs] = quiet.split(/\r\n(?=m=)/);
    expect(mine).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1");
    expect(theirs).not.toContain("usedtx");
    expect(quiet.endsWith("\r\n")).toBe(true);
  });

  it("adds the line when the offer gives Opus none, and never twice", () => {
    const bare = OFFER.replace("a=fmtp:111 minptime=10;useinbandfec=1\r\na=extmap", "a=extmap");
    expect(withQuietSilence(bare, "0")).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 usedtx=1");
    const once = withQuietSilence(OFFER, "0");
    expect(withQuietSilence(once, "0").match(/usedtx/g)).toHaveLength(1);
  });
});

describe("who's talking on the phone", () => {
  it("lights at the desktop's level and goes out after the same hangover", () => {
    const gate = new Gate();
    expect(gate.update(TALKING_LEVEL / 2, 0)).toBeNull();
    expect(gate.update(TALKING_LEVEL, 10)).toBe(true);
    expect(gate.update(0.5, 50)).toBeNull();
    expect(gate.update(0, 50 + HANGOVER_MS - 1)).toBeNull();
    expect(gate.update(0, 50 + HANGOVER_MS)).toBe(false);
    expect(gate.isOn).toBe(false);
  });

  it("is the desktop's 500 on 16-bit samples, so a phone and a computer agree", () => {
    expect(Math.round(TALKING_LEVEL * 32767)).toBe(500);
  });
});

describe("a microphone that won't open", () => {
  const said = (name: string) => voiceStartProblem(microphoneProblem(new DOMException("boom", name)), false, { input: null, output: null }, true).line;

  it("says it in the strip's words, with nothing to pick on a phone", () => {
    expect(said("NotAllowedError")).toBe("Linger isn't allowed to use the microphone.");
    expect(said("NotFoundError")).toBe("No microphone found.");
    expect(said("NotReadableError")).toBe("The microphone is in use by another app.");
  });
});
