import { describe, expect, it } from "vitest";
import type { VoicePeer } from "../../generated/VoicePeer";
import { serverState } from "../../lib/gateway";
import { myScreen, seatedIn, shareBy, sharersIn, shareStoppedWords, sharingPeople, watchersOf, watchingWords } from "./screens";

function withVoice(peers: VoicePeer[], session = "s-me") {
  return { ...serverState("https://screens.example"), sessionId: session, voice: { "r-1": peers }, myVoice: null };
}

describe("who shares and who watches (#360)", () => {
  const peers: VoicePeer[] = [
    { session_id: "s-jules", user_id: "u-jules", screen: { fps: 30 } },
    { session_id: "s-eli", user_id: "u-eli", watching: "s-jules" },
    { session_id: "s-eli-laptop", user_id: "u-eli", watching: "s-jules" },
    { session_id: "s-me", user_id: "u-me", watching: "s-dave" },
    { session_id: "s-dave", user_id: "u-dave", screen: { fps: 60 } },
  ];
  const state = withVoice(peers);

  it("lists the shares in a room's voice, by session, at their speeds", () => {
    expect(sharersIn(state, "r-1")).toEqual([
      { session: "s-jules", userId: "u-jules", fps: 30 },
      { session: "s-dave", userId: "u-dave", fps: 60 },
    ]);
    expect(sharersIn(state, "r-elsewhere")).toEqual([]);
  });

  it("names each watcher once, however many of their computers watch", () => {
    expect(watchersOf(state, "r-1", "s-jules")).toEqual(["u-eli"]);
    expect(watchersOf(state, "r-1", "s-dave")).toEqual(["u-me"]);
  });

  it("finds a person's share in a room's voice, never this connection's own, for an ended screen to open", () => {
    expect(shareBy(state, "r-1", "u-jules")).toBe("s-jules");
    expect(shareBy(state, "r-1", "u-eli")).toBeNull();
    expect(shareBy(state, "r-elsewhere", "u-jules")).toBeNull();
    expect(shareBy(withVoice(peers, "s-jules"), "r-1", "u-jules")).toBeNull();
  });

  it("marks everybody sharing anywhere, for their rows", () => {
    expect([...sharingPeople(state)].sort()).toEqual(["u-dave", "u-jules"]);
  });

  it("says who is watching in words, never as a number", () => {
    expect(watchingWords([])).toBe("Nobody's watching yet");
    expect(watchingWords(["Eli"])).toBe("Eli is watching");
    expect(watchingWords(["Matt", "Eli"])).toBe("Matt and Eli are watching");
    expect(watchingWords(["Matt", "Eli", "Dave"])).toBe("Matt, Eli and Dave are watching");
    for (const words of [watchingWords(["a", "b", "c", "d", "e"])]) expect(words).not.toMatch(/\d/);
  });

  it("knows this connection's own seat from the server's word", () => {
    expect(seatedIn(state, "r-1")).toBe(true);
    expect(seatedIn(withVoice(peers, "s-nobody"), "r-1")).toBe(false);
    // No seat of its own until the client knows it's in voice.
    expect(myScreen(state)).toBeNull();
  });
});

describe("a share that ended by itself (#360)", () => {
  it("says why in words, and nothing when you left or stopped it", () => {
    expect(shareStoppedWords("room-full")).toMatch(/Three people are sharing here already/);
    expect(shareStoppedWords("dropped")).toMatch(/connection to the server dropped/);
    expect(shareStoppedWords("bad-hello")).toMatch(/may need an update/);
    // Turned off by the host while you shared: said once, not tried again.
    expect(shareStoppedWords("off")).toMatch(/screen sharing turned off/);
    // The computer handed over no screen, or no pictures of it (T-1907).
    expect(shareStoppedWords("no-screen")).toMatch(/didn't give Linger a screen/);
    expect(shareStoppedWords("no-frames")).toMatch(/couldn't read the screen you picked/);
    for (const quiet of ["ended", "replaced", "not-in-voice", "nothing-to-watch"] as const) expect(shareStoppedWords(quiet)).toBeNull();
  });
});
