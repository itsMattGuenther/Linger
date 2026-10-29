import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../generated/ServerFrame";
import type { User } from "../generated/User";
import type { VoicePeer } from "../generated/VoicePeer";
import { apply, type GatewayState, type MyVoice, serverState } from "./gateway";
import { controlCue, PeerCueLimit, shareChange, ShareCues, voiceCueToPlay, WATCH_JOIN_WAIT_MS, WatchCues } from "./sound-events";

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
    refused: null,
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

// ---------------------------------------------------------------------------
// Somebody starting to watch your share (#735)

const ME: VoicePeer = { session_id: "s-me", user_id: "u-me" };
const SHARING: VoicePeer = { ...ME, screen: { fps: 60 } };
const ELI: VoicePeer = { session_id: "s-eli", user_id: "u-eli" };
const DEX: VoicePeer = { session_id: "s-dex", user_id: "u-dex" };
const MY_LAPTOP: VoicePeer = { session_id: "s-me-laptop", user_id: "u-me" };
const watching = (peer: VoicePeer, target = "s-me"): VoicePeer => ({ ...peer, watching: target });

const MATT: User = {
  id: "u-me",
  username: "matt",
  display_name: "Matt",
  is_host: false,
  is_cohost: false,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
  status: null,
  entrance_sound: null,
  last_seen_at: null,
};

/**
 * Your list window's side of one room's voice: each frame folded as the
 * store folds it, its voice cue picked as the store picks it, and what the
 * two together play written down.
 */
function room() {
  const played: string[] = [];
  let state: GatewayState = { ...serverState("https://watching.example"), sessionId: "s-me", myVoice: seat({ roomId: "r-1" }) };
  let there = true;
  const limit = new PeerCueLimit();
  const cues = new WatchCues((cue) => played.push(cue), () => there);
  const hear = (frame: ServerFrame, replayed = false) => {
    const before = state;
    state = apply(state, frame);
    const now = Date.now();
    cues.hear(frame, before, state, replayed ? null : voiceCueToPlay(frame, before, state, limit, now), !replayed, now);
  };
  return {
    played,
    voice: (peers: VoicePeer[], replayed = false) => hear({ s: 2, op: "voice.state", d: { room_id: "r-1", peers } }, replayed),
    hear,
    /** You leave that voice, as Leave does: your seat goes before the server says so. */
    leave: () => {
      there = false;
      state = { ...state, myVoice: null };
    },
  };
}

/** In voice with Eli, sharing, and the chimes so far forgotten. */
function sharingWithEli() {
  const here = room();
  here.voice([ME, ELI]);
  here.voice([SHARING, ELI]);
  here.played.length = 0;
  return here;
}

const later = (ms: number) => vi.advanceTimersByTime(ms);

describe("the chime for somebody starting to watch your screen (#735)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-27T20:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("rings once when somebody starts watching, and not for the same list again", () => {
    const here = sharingWithEli();
    here.voice([SHARING, watching(ELI)]);
    expect(here.played).toEqual(["watcher"]);
    here.voice([SHARING, watching(ELI)]);
    expect(here.played).toEqual(["watcher"]);
    // Somebody else starting is news.
    here.voice([SHARING, watching(ELI), DEX]);
    here.voice([SHARING, watching(ELI), watching(DEX)]);
    later(WATCH_JOIN_WAIT_MS);
    expect(here.played).toEqual(["watcher", "watcher"]);
  });

  it("rings at most once a minute for each person: Watch, close and Watch again is one ring", () => {
    const here = sharingWithEli();
    here.voice([SHARING, watching(ELI)]);
    for (let again = 0; again < 3; again += 1) {
      later(10_000);
      here.voice([SHARING, ELI]);
      later(10_000);
      here.voice([SHARING, watching(ELI)]);
    }
    expect(here.played).toEqual(["watcher"]);
    // Gone a whole minute, and back: that rings again.
    here.voice([SHARING, ELI]);
    later(59_999);
    here.voice([SHARING, watching(ELI)]);
    here.voice([SHARING, ELI]);
    later(60_000);
    here.voice([SHARING, watching(ELI)]);
    expect(here.played).toEqual(["watcher", "watcher"]);
  });

  it("is silent when a watcher's line drops and comes back, however long they've watched (#725)", () => {
    const here = sharingWithEli();
    here.voice([SHARING, watching(ELI)]);
    later(10 * 60_000);
    // The server ends a watch whose socket closed, and the app tries again
    // after 1, 2, 4 and 8 seconds.
    here.voice([SHARING, ELI]);
    later(1_000 + 2_000 + 4_000 + 8_000);
    here.voice([SHARING, watching(ELI)]);
    expect(here.played).toEqual(["watcher"]);
    // Your own share's line dropping ends the share, and the watching with
    // it: once it's back, they are the same watch too.
    here.voice([ME, ELI]);
    later(3_000);
    here.voice([SHARING, ELI]);
    here.voice([SHARING, watching(ELI)]);
    expect(here.played).toEqual(["watcher"]);
  });

  it("is silent for the list a share starts with, a fresh session's snapshot, and a resume's replay", () => {
    // The first list after your share starts says where it stands.
    const starting = room();
    starting.voice([ME, ELI]);
    starting.played.length = 0;
    starting.voice([SHARING, watching(ELI)]);
    expect(starting.played).toEqual([]);
    // A fresh session's `ready`, sharing and watched in its snapshot.
    const fresh = sharingWithEli();
    fresh.hear({ s: 1, op: "ready", d: { session_id: "s-me", user: MATT, users: [MATT], rooms: [], dms: [], presence: [], voice: [{ room_id: "r-1", peers: [SHARING, watching(ELI)] }] } });
    expect(fresh.played).toEqual([]);
    // A replay plays nothing, and the live list after it, with Eli still watching, is nothing new.
    const resumed = sharingWithEli();
    resumed.voice([SHARING, watching(ELI)], true);
    resumed.voice([SHARING, watching(ELI)]);
    expect(resumed.played).toEqual([]);
  });

  it("is silent when somebody stops watching, and for you watching your own share from another computer", () => {
    const here = sharingWithEli();
    here.voice([SHARING, watching(ELI)]);
    here.voice([SHARING, ELI]);
    expect(here.played).toEqual(["watcher"]);
    // Your laptop joining voice is a join, as it always was, at once: it's
    // nobody's Watch to wait for, and your laptop watching rings nothing.
    here.voice([SHARING, ELI, watching(MY_LAPTOP)]);
    expect(here.played).toEqual(["watcher", "peer-join"]);
    later(WATCH_JOIN_WAIT_MS);
    expect(here.played).toEqual(["watcher", "peer-join"]);
  });

  it("rings only for the person sharing: watching somebody else's share, or another watcher there, is silent", () => {
    const JULES: VoicePeer = { session_id: "s-jules", user_id: "u-jules", screen: { fps: 30 } };
    const here = room();
    here.voice([ME, JULES, ELI]);
    here.played.length = 0;
    here.voice([watching(ME, "s-jules"), JULES, ELI]);
    here.voice([watching(ME, "s-jules"), JULES, watching(ELI, "s-jules")]);
    expect(here.played).toEqual([]);
    // Sharing too: Eli watching Jules's still isn't yours.
    here.voice([watching(SHARING, "s-jules"), JULES, ELI]);
    here.voice([watching(SHARING, "s-jules"), JULES, watching(ELI, "s-jules")]);
    expect(here.played).toEqual([]);
  });

  it("a Watch that joins voice first rings only this, not the voice join too", () => {
    const here = room();
    here.voice([ME]);
    here.voice([SHARING]);
    here.played.length = 0;
    // Eli presses Watch from outside voice: the seat first, the watching a moment later.
    here.voice([SHARING, ELI]);
    later(600);
    expect(here.played).toEqual([]);
    here.voice([SHARING, watching(ELI)]);
    later(5_000);
    expect(here.played).toEqual(["watcher"]);
    // Gone from voice, then back a minute later with both in one list: the same.
    here.voice([SHARING]);
    later(60_000);
    here.played.length = 0;
    here.voice([SHARING, watching({ ...ELI, session_id: "s-eli-2" })]);
    later(5_000);
    expect(here.played).toEqual(["watcher"]);
  });

  it("a voice join while you share that isn't a Watch rings a moment late, and not after you've left", () => {
    const here = room();
    here.voice([ME]);
    here.voice([SHARING]);
    here.played.length = 0;
    here.voice([SHARING, ELI]);
    later(WATCH_JOIN_WAIT_MS - 1);
    expect(here.played).toEqual([]);
    later(1);
    expect(here.played).toEqual(["peer-join"]);
    // Somebody joining as you leave voice: nothing after your own leave.
    here.voice([SHARING, ELI, DEX]);
    here.leave();
    later(WATCH_JOIN_WAIT_MS);
    expect(here.played).toEqual(["peer-join"]);
    // Not sharing, a join rings at once, as it always has.
    const plain = room();
    plain.voice([ME]);
    plain.voice([ME, ELI]);
    expect(plain.played).toEqual(["voice-join", "peer-join"]);
  });
});

// ---------------------------------------------------------------------------
// A screen share starting in the voice you're in (#746)

const JULES: VoicePeer = { session_id: "s-jules", user_id: "u-jules" };
const JULES_SHARING: VoicePeer = { ...JULES, screen: { fps: 30 } };
const JULES_DESKTOP: VoicePeer = { session_id: "s-jules-desktop", user_id: "u-jules" };

/** Your list window's side of one room's voice, with only the share chords written down. */
function shareRoom() {
  const played: string[] = [];
  let state: GatewayState = { ...serverState("https://sharing.example"), sessionId: "s-me", myVoice: seat({ roomId: "r-1" }) };
  const cues = new ShareCues((cue) => played.push(cue));
  const hear = (frame: ServerFrame, replayed = false) => {
    const before = state;
    state = apply(state, frame);
    cues.hear(frame, before, state, !replayed, Date.now());
  };
  return {
    played,
    hear,
    voice: (peers: VoicePeer[], replayed = false, room = "r-1") => hear({ s: 2, op: "voice.state", d: { room_id: room, peers } }, replayed),
  };
}

describe("the chords for a screen share starting and stopping (#746)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-29T20:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("ring for everybody in that voice when somebody starts sharing, and step down when they stop", () => {
    const here = shareRoom();
    here.voice([ME, ELI, JULES]);
    here.voice([ME, ELI, JULES_SHARING]);
    expect(here.played).toEqual(["share"]);
    // The same list again, or somebody starting to watch it, is nothing new.
    here.voice([ME, ELI, JULES_SHARING]);
    here.voice([ME, watching(ELI, "s-jules"), JULES_SHARING]);
    expect(here.played).toEqual(["share"]);
    // Somebody else starting too is.
    here.voice([ME, { ...ELI, screen: { fps: 60 } }, JULES_SHARING]);
    expect(here.played).toEqual(["share", "share"]);
    // Jules stopping.
    here.voice([ME, { ...ELI, screen: { fps: 60 } }, JULES]);
    expect(here.played).toEqual(["share", "share", "share-stop"]);
  });

  it("ring for the person sharing too, every time their own share starts and stops", () => {
    const here = shareRoom();
    here.voice([ME, ELI]);
    for (let again = 0; again < 3; again += 1) {
      here.voice([SHARING, ELI]);
      later(5_000);
      here.voice([ME, ELI]);
      later(5_000);
    }
    expect(here.played).toEqual(["share", "share-stop", "share", "share-stop", "share", "share-stop"]);
  });

  it("sound a stop and a start for stopping to pick another window, once a minute apiece, as joining and leaving voice do", () => {
    const here = shareRoom();
    here.voice([ME, JULES]);
    here.voice([ME, JULES_SHARING]);
    later(20 * 60_000);
    // Picking another window: the stop, then the start.
    here.voice([ME, JULES]);
    later(15_000);
    here.voice([ME, JULES_SHARING]);
    expect(here.played).toEqual(["share", "share-stop", "share"]);
    // Doing it again inside the minute is quiet, both ways.
    later(20_000);
    here.voice([ME, JULES]);
    later(10_000);
    here.voice([ME, JULES_SHARING]);
    expect(here.played).toEqual(["share", "share-stop", "share"]);
    // A minute on, each is news again.
    later(60_000);
    here.voice([ME, JULES]);
    later(5_000);
    here.voice([ME, JULES_SHARING]);
    expect(here.played).toEqual(["share", "share-stop", "share", "share-stop", "share"]);
  });

  it("are silent for a share already going when you join, a fresh session's list, a resume's replay, and your leaving", () => {
    // Joining a voice where Jules is sharing already.
    const joining = shareRoom();
    joining.voice([JULES_SHARING]);
    joining.voice([JULES_SHARING, ME]);
    expect(joining.played).toEqual([]);
    // A fresh session's snapshot with a share in it, or without the one there was.
    const fresh = shareRoom();
    fresh.voice([ME, JULES]);
    fresh.hear({ s: 1, op: "ready", d: { session_id: "s-me-2", user: MATT, users: [MATT], rooms: [], dms: [], presence: [], voice: [{ room_id: "r-1", peers: [ME, JULES_SHARING] }] } });
    expect(fresh.played).toEqual([]);
    // A replay plays nothing, and the live list after it is nothing new.
    const resumed = shareRoom();
    resumed.voice([ME, JULES]);
    resumed.voice([ME, JULES_SHARING], true);
    resumed.voice([ME, JULES_SHARING]);
    resumed.voice([ME, JULES], true);
    resumed.voice([ME, JULES]);
    expect(resumed.played).toEqual([]);
    // You leaving voice while somebody shares, or while you share, isn't a stop.
    const leaving = shareRoom();
    leaving.voice([SHARING, JULES_SHARING]);
    leaving.voice([JULES_SHARING]);
    expect(leaving.played).toEqual([]);
  });

  it("are silent when a share ends because its person left voice: the leave sound says so", () => {
    const here = shareRoom();
    here.voice([ME, JULES]);
    here.voice([ME, JULES_SHARING]);
    here.voice([ME]);
    expect(here.played).toEqual(["share"]);
  });

  it("are silent for a share in a voice you aren't in, and a second computer of the same person's", () => {
    const here = shareRoom();
    here.voice([ME]);
    here.voice([JULES], false, "r-2");
    here.voice([JULES_SHARING], false, "r-2");
    here.voice([JULES], false, "r-2");
    expect(here.played).toEqual([]);
    // Jules's desktop starting while the laptop shares is the same share, and so is it stopping.
    here.voice([ME, JULES, JULES_DESKTOP]);
    here.voice([ME, JULES_SHARING, JULES_DESKTOP]);
    expect(here.played).toEqual(["share"]);
    here.voice([ME, JULES_SHARING, { ...JULES_DESKTOP, screen: { fps: 60 } }]);
    here.voice([ME, JULES_SHARING, JULES_DESKTOP]);
    expect(here.played).toEqual(["share"]);
  });

  it("sound the start when one person starts and another stops at once", () => {
    const here = shareRoom();
    here.voice([ME, ELI, JULES]);
    here.voice([ME, ELI, JULES_SHARING]);
    later(5 * 60_000);
    here.voice([ME, { ...ELI, screen: { fps: 60 } }, JULES]);
    expect(here.played).toEqual(["share", "share"]);
  });

  it("tell who started and who stopped, and leave out somebody who left", () => {
    const before: GatewayState = { ...serverState("https://sharing.example"), sessionId: "s-me", myVoice: seat({ roomId: "r-1" }), voice: { "r-1": [ME, ELI, JULES_SHARING, { ...DEX, screen: { fps: 30 } }] } };
    const frame: ServerFrame = { s: 3, op: "voice.state", d: { room_id: "r-1", peers: [ME, { ...ELI, screen: { fps: 60 } }, JULES] } };
    expect(shareChange(frame, before, apply(before, frame))).toEqual({ started: [{ session: "s-eli", person: "u-eli" }], stopped: [{ session: "s-jules", person: "u-jules" }] });
  });
});
