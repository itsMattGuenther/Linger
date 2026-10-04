/**
 * The store's part in voice (SPEC §4.14, T-1404): folding the server's
 * `voice.state`, holding our own seat, and talking to the core.
 *
 * Same shape as `gateway.test.ts` — the core is mocked down to the events
 * the store listens for and the commands it sends — and kept apart from it
 * because voice has its own three events and its own failure modes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadyData } from "../generated/ReadyData";
import type { ServerFrame } from "../generated/ServerFrame";
import type { User } from "../generated/User";
import type { AuthedApi } from "./api";

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
/** Commands that should reject, to see what the store does with a refusal. */
const failing = new Set<string>();

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: Record<string, unknown>): Promise<boolean> => {
    invoked.push({ cmd, args });
    if (failing.has(cmd)) throw new Error(`no ${cmd} today`);
    return true;
  },
}));

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler): Promise<() => void> => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));

vi.mock("./notify", () => ({ considerFrame: () => undefined }));
const played: string[] = [];
vi.mock("./sound", () => ({ playKnock: () => false, playSound: (cue: string) => { played.push(cue); return true; } }));

const {
  connect,
  disconnect,
  joinVoice,
  leaveVoice,
  OLD_WAY,
  serverState,
  setVoiceMuted,
  sharedLocalOf,
  setVoiceDeafened,
  setVoicePushToTalk,
  setVoiceTalking,
  setVoiceVolume,
  voicePeersIn,
} = await import("./gateway");
const { startProblemWords, voiceStartProblem } = await import("./voice");

const HOME = "https://home.example";
const WORK = "https://work.example";

function fakeApi(baseUrl: string, get?: (path: string) => unknown): AuthedApi {
  const stub = {
    baseUrl,
    accessToken: async () => ({ token: `token-${baseUrl}`, expiresAt: 0 }),
    get: async (path: string) => {
      if (!get) throw new Error(`unexpected GET ${path}`);
      return get(path);
    },
  };
  return stub as unknown as AuthedApi;
}

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

const MATT = person("u-matt", "Matt");

function ready(data: Partial<ReadyData> = {}): ServerFrame {
  return {
    s: 1,
    op: "ready",
    d: {
      session_id: "s-me",
      user: MATT,
      users: [MATT],
      rooms: [],
      dms: [],
      presence: [],
      ...data,
    },
  };
}

/** Who is in voice in a room, every seat forwarded, as every server that carries voice now says (#306). */
function voiceState(roomId: string, seats: [string, string][], forwarded = true): ServerFrame {
  return {
    s: 2,
    op: "voice.state",
    d: {
      room_id: roomId,
      peers: seats.map(([session_id, user_id]) => (forwarded ? { session_id, user_id, forwarded: true } : { session_id, user_id })),
    },
  };
}

function arrive(server: string, frame: ServerFrame): void {
  handlers.get("gateway:frame")?.({ payload: { server, frame } });
}

function coreEvent(name: string, payload: unknown): void {
  handlers.get(name)?.({ payload });
}

const DEFAULTS = { input: null, output: null };

async function seated(server: string): Promise<void> {
  await connect(fakeApi(server));
  arrive(server, ready());
  await joinVoice(fakeApi(server), "r-garage", DEFAULTS, false);
}

describe("voice in the store", () => {
  beforeEach(async () => {
    await Promise.all([disconnect(HOME), disconnect(WORK)]);
    invoked.length = 0;
    failing.clear();
    played.length = 0;
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
  });

  it("seeds voice from ready without joining or making a sound", async () => {
    await connect(fakeApi(HOME));
    invoked.length = 0;
    arrive(HOME, ready({ voice: [{ room_id: "r-garage", peers: [{ session_id: "friend", user_id: "amy" }] }] }));
    expect(voicePeersIn(serverState(HOME), "r-garage")).toHaveLength(1);
    expect(serverState(HOME).myVoice).toBeNull();
    expect(invoked.filter((call) => call.cmd.startsWith("voice_"))).toEqual([]);
    expect(played).toEqual([]);
  });

  it("restores volume across visits, reconnects, a fresh store and two sessions of one person", async () => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["a", "amy"], ["b", "amy"], ["c", "cal"]]));
    await vi.waitFor(() => expect(serverState(HOME).myVoice?.volumes.c).toBe(1));
    setVoiceVolume(HOME, "a", 1.75);
    expect(serverState(HOME).myVoice?.volumes).toMatchObject({ a: 1.75, b: 1.75, c: 1 });
    expect(localStorage.getItem(`linger.voice.volumes:${HOME}`)).toBe('{"amy":1.75}');
    await setVoiceDeafened(HOME, true);
    await setVoiceDeafened(HOME, false);
    await leaveVoice(HOME);
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    expect(serverState(HOME).myVoice?.volumes).toMatchObject({ a: 1.75, b: 1.75 });
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["new-session", "amy"]]));
    await vi.waitFor(() => expect(serverState(HOME).myVoice?.volumes["new-session"]).toBe(1.75));
    expect(serverState(HOME).myVoice?.volumes["new-session"]).toBe(1.75);
    await disconnect(HOME);
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ voice: [{ room_id: "r-garage", peers: [{ session_id: "after-restart", user_id: "amy" }] }] }));
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    expect(serverState(HOME).myVoice?.volumes["after-restart"]).toBe(1.75);
    expect(invoked).toContainEqual({ cmd: "voice_volume", args: { baseUrl: HOME, peer: "after-restart", volume: 1.75 } });
    await connect(fakeApi(WORK));
    arrive(WORK, ready({ voice: [{ room_id: "r-garage", peers: [{ session_id: "other-server", user_id: "amy" }] }] }));
    await joinVoice(fakeApi(WORK), "r-garage", DEFAULTS, false);
    expect(serverState(WORK).myVoice?.volumes["other-server"]).toBe(1);
  });

  it("remembers the session id from ready, and who is in voice per room", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    expect(serverState(HOME).sessionId).toBe("s-me");

    arrive(HOME, voiceState("r-garage", [["s-1", "u-amy"], ["s-2", "u-zed"]]));
    expect(voicePeersIn(serverState(HOME), "r-garage").map((p) => p.session_id)).toEqual([
      "s-1",
      "s-2",
    ]);
    expect(voicePeersIn(serverState(HOME), "r-else")).toEqual([]);

    // The whole list every time: a shorter one replaces, an empty one removes.
    arrive(HOME, voiceState("r-garage", [["s-2", "u-zed"]]));
    expect(voicePeersIn(serverState(HOME), "r-garage").map((p) => p.session_id)).toEqual(["s-2"]);
    arrive(HOME, voiceState("r-garage", []));
    expect(serverState(HOME).voice).toEqual({});
  });

  it("joins with the session id and the chosen devices, closing the microphone first for push-to-talk without muting (#232)", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    invoked.length = 0;

    await joinVoice(fakeApi(HOME), "r-garage", { input: "USB Mic", output: null }, true);

    const calls = invoked.filter((call) => call.cmd.startsWith("voice_"));
    expect(calls.map((call) => call.cmd)).toEqual(["voice_controls", "voice_push_to_talk", "voice_join"]);
    // The room is told the microphone is on; the key's gate closes it here.
    expect(calls[0]?.args).toEqual({ baseUrl: HOME, controls: { muted: false, deafened: false } });
    expect(calls[1]?.args).toEqual({ baseUrl: HOME, closed: true });
    expect(calls[2]?.args).toEqual({
      baseUrl: HOME,
      sessionId: "s-me",
      roomId: "r-garage",
      input: "USB Mic",
      output: null,
      // The fake server has no `/voice/ice`, which is what a host with no
      // relay looks like: the join goes ahead with no servers.
      ice: [],
    });
    expect(serverState(HOME).myVoice).toMatchObject({
      roomId: "r-garage",
      muted: false,
      pushToTalk: true,
      talkHeld: false,
      audio: "opening",
    });
  });

  it("asks the server for its relay and hands it to the core", async () => {
    const relay = {
      servers: [
        {
          urls: ["stun:linger.example:3478", "turn:linger.example:3478?transport=udp"],
          username: "1700003600:u-matt",
          credential: "RsyZfOxxNUxMkeEW3E6QK5TmlsU=",
        },
      ],
      ttl_secs: 3600,
    };
    const api = fakeApi(HOME, (path) => {
      if (path === "/voice/ice") return relay;
      throw new Error(`unexpected GET ${path}`);
    });
    await connect(api);
    arrive(HOME, ready());
    invoked.length = 0;

    await joinVoice(api, "r-garage", DEFAULTS, false);

    const join = invoked.find((call) => call.cmd === "voice_join");
    expect(join?.args.ice).toEqual(relay.servers);
  });

  it("refuses to join before the session exists", async () => {
    await connect(fakeApi(HOME));
    await expect(joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false)).rejects.toThrow(
      /not connected/i,
    );
    expect(serverState(HOME).myVoice).toBeNull();
  });

  it("gives up a seat on one server before taking one on another", async () => {
    await seated(HOME);
    await connect(fakeApi(WORK));
    arrive(WORK, ready());
    invoked.length = 0;

    await joinVoice(fakeApi(WORK), "r-standup", DEFAULTS, false);

    const calls = invoked.filter((call) => call.cmd.startsWith("voice_"));
    expect(calls.map((call) => [call.cmd, call.args.baseUrl])).toEqual([
      ["voice_leave", HOME],
      ["voice_controls", WORK],
      ["voice_push_to_talk", WORK],
      ["voice_join", WORK],
    ]);
    expect(serverState(HOME).myVoice).toBeNull();
    expect(serverState(WORK).myVoice?.roomId).toBe("r-standup");
  });

  it("a refused join leaves no seat behind and says why", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    failing.add("voice_join");

    await expect(joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false)).rejects.toThrow(
      /no voice_join today/,
    );
    expect(serverState(HOME).myVoice).toBeNull();
    // The reason stays, for the room's strip to show (#261), with the devices
    // it asked for, which say what fixes it (#273). It is shared with the
    // other windows along with the seat.
    expect(serverState(HOME).voiceFailed).toEqual({
      roomId: "r-garage",
      problem: expect.stringMatching(/no voice_join today/),
      devices: DEFAULTS,
    });
    expect(sharedLocalOf(HOME).voiceFailed?.roomId).toBe("r-garage");
    expect(sharedLocalOf(HOME).voiceFailed?.devices).toEqual(DEFAULTS);
    // A try with a device picked by name remembers that one.
    const picked = { input: "USB Microphone", output: null };
    await expect(joinVoice(fakeApi(HOME), "r-garage", picked, false)).rejects.toThrow(/no voice_join today/);
    expect(serverState(HOME).voiceFailed?.devices).toEqual(picked);

    // The next try clears it, whether or not it works.
    failing.delete("voice_join");
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    expect(serverState(HOME).voiceFailed).toBeNull();
    expect(serverState(HOME).myVoice?.roomId).toBe("r-garage");
  });

  it("loses the seat, and tells the core, when the server's list no longer has us", async () => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "u-amy"]]));
    expect(serverState(HOME).myVoice).not.toBeNull();
    invoked.length = 0;

    // Somebody else's room changing is not our business.
    arrive(HOME, voiceState("r-else", [["s-9", "u-zed"]]));
    expect(serverState(HOME).myVoice).not.toBeNull();

    // Our room, without us: the seat is gone and the microphone must go too.
    arrive(HOME, voiceState("r-garage", [["s-1", "u-amy"]]));
    expect(serverState(HOME).myVoice).toBeNull();
    expect(invoked.filter((call) => call.cmd === "voice_leave")).toHaveLength(1);
  });

  it("is taken out by the host: the seat ends at once, the core lets go, and the strip has why until the next join (#423)", async () => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "u-amy"]]));
    invoked.length = 0;

    arrive(HOME, { s: 3, op: "voice.removed", d: { room_id: "r-garage" } });
    expect(serverState(HOME).myVoice).toBeNull();
    expect(serverState(HOME).voiceTakenOut).toBe("r-garage");
    expect(invoked.filter((call) => call.cmd === "voice_leave")).toHaveLength(1);

    // The room's list without us follows, and lets go of nothing twice.
    arrive(HOME, voiceState("r-garage", [["s-1", "u-amy"]]));
    expect(invoked.filter((call) => call.cmd === "voice_leave")).toHaveLength(1);
    expect(serverState(HOME).voiceTakenOut).toBe("r-garage");

    // Not a ban: joining again is allowed, and clears it.
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    expect(serverState(HOME).voiceTakenOut).toBeNull();
    expect(serverState(HOME).myVoice?.roomId).toBe("r-garage");
  });

  // A server from before the mesh was taken out sends a room the old way when
  // it doesn't forward, or an older app is in it. This app has no old way:
  // it leaves, and the strip says why (#306).
  it("leaves, and says why, when the server sends the call the old way", async () => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "u-amy"]]));
    expect(serverState(HOME).myVoice).not.toBeNull();
    invoked.length = 0;

    // Another room going the old way is not our business.
    arrive(HOME, voiceState("r-else", [["s-9", "u-zed"]], false));
    expect(serverState(HOME).myVoice).not.toBeNull();

    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "u-amy"]], false));
    await vi.waitFor(() => expect(serverState(HOME).voiceFailed).toMatchObject({ roomId: "r-garage", problem: OLD_WAY }));
    expect(serverState(HOME).myVoice).toBeNull();
    expect(invoked.filter((call) => call.cmd === "voice_leave")).toHaveLength(1);
    expect(startProblemWords(voiceStartProblem(OLD_WAY, false, DEFAULTS))).toBe("This server needs an update for voice. Ask its host.");
  });

  it("folds the core's own events into the seat, and ignores them without one", async () => {
    await seated(HOME);

    coreEvent("voice:peer", { server: HOME, peer: "s-1", state: "connected" });
    coreEvent("voice:audio", { server: HOME, state: "sending" });
    coreEvent("voice:speaking", { server: HOME, peer: "s-1", speaking: true });
    coreEvent("voice:speaking", { server: HOME, peer: null, speaking: true });

    expect(serverState(HOME).myVoice).toMatchObject({
      peers: { "s-1": "connected" },
      audio: "sending",
      refused: null,
      speaking: { "s-1": true },
      talking: true,
    });

    // The microphone picked in Settings wouldn't open, so the default is in
    // its place (#398), and then it's picked again and does.
    const refused = { name: "Headset Microphone (SteelSeries Arctis Nova 5)", why: "the device is in use" };
    coreEvent("voice:microphone", { server: HOME, refused });
    expect(serverState(HOME).myVoice?.refused).toEqual(refused);
    coreEvent("voice:microphone", { server: HOME, refused: null });
    expect(serverState(HOME).myVoice?.refused).toBeNull();

    await leaveVoice(HOME);
    expect(serverState(HOME).myVoice).toBeNull();
    coreEvent("voice:speaking", { server: HOME, peer: "s-1", speaking: false });
    expect(serverState(HOME).myVoice).toBeNull();
  });

  it("mute and volume are remembered and sent through the native engine", async () => {
    await seated(HOME);
    invoked.length = 0;

    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "u-amy"]]));
    await vi.waitFor(() => expect(serverState(HOME).myVoice?.volumes["s-1"]).toBe(1));
    invoked.length = 0;
    await setVoiceMuted(HOME, true);
    setVoiceVolume(HOME, "s-1", 1.5);

    expect(serverState(HOME).myVoice).toMatchObject({ muted: true, volumes: { "s-1": 1.5 } });
    const calls = invoked.filter((call) => call.cmd.startsWith("voice_"));
    expect(calls.map((call) => call.cmd)).toEqual(["voice_controls", "voice_volume"]);
    // Native code applies the audio gates before reporting controls to the server.
    expect(invoked.some((call) => call.cmd === "gateway_send")).toBe(false);
  });

  it.each([false, true])("deafen restores prior mute=%s and preserves volume", async (muted) => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["friend", "u-amy"]]));
    await Promise.resolve();
    await setVoiceMuted(HOME, muted);
    setVoiceVolume(HOME, "friend", 0.4);
    await setVoiceDeafened(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ muted: true, deafened: true });
    await setVoiceMuted(HOME, false);
    expect(serverState(HOME).myVoice?.muted).toBe(true);
    await setVoiceDeafened(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ muted, deafened: false, volumes: { friend: 0.4 } });
  });

  it("push-to-talk stays closed after undeafen, even if its key was held", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    const gate = () => invoked.filter((call) => call.cmd === "voice_push_to_talk").at(-1)?.args.closed;
    await setVoiceTalking(HOME, true);
    expect(gate()).toBe(false);
    await setVoiceDeafened(HOME, true);
    // Deafening lets go of the key, and the key can't reopen a deafened mic.
    expect(gate()).toBe(true);
    await setVoiceTalking(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: false, muted: true, deafened: true });
    await setVoiceDeafened(HOME, false);
    // Back to the mic you had chosen, which was on, and closed by the key until it's pressed again.
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: false, muted: false, deafened: false });
    expect(gate()).toBe(true);
    await setVoiceTalking(HOME, true);
    expect(serverState(HOME).myVoice?.talkHeld).toBe(true);
    expect(gate()).toBe(false);
  });

  it("the push-to-talk key opens and closes the microphone without muting you or telling the room (#232)", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    invoked.length = 0;
    await setVoiceTalking(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: true, muted: false });
    await setVoiceTalking(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: false, muted: false });
    // Only the engine's gate moved: no controls, so nothing for the room.
    expect(invoked.map((call) => [call.cmd, call.args.closed])).toEqual([
      ["voice_push_to_talk", false],
      ["voice_push_to_talk", true],
    ]);

    // A mute you chose is reported, and holding the key doesn't undo it.
    await setVoiceMuted(HOME, true);
    await setVoiceTalking(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: true, muted: true });
    expect(invoked.filter((call) => call.cmd === "voice_controls").map((call) => call.args.controls)).toEqual([{ muted: true, deafened: false }]);
  });

  it("leaves voice when the key's gate can't be set, rather than guess whether the microphone is open", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    failing.add("voice_push_to_talk");
    await expect(setVoiceTalking(HOME, true)).rejects.toThrow(/disconnected/);
    expect(serverState(HOME).myVoice).toBeNull();
    expect(invoked.at(-1)?.cmd).toBe("voice_leave");
  });

  it("turning push-to-talk off mid-call opens the microphone, and on closes it until the key is held (#231)", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    expect(serverState(HOME).myVoice).not.toBeNull();
    invoked.length = 0;

    await setVoicePushToTalk(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: false, talkHeld: false, muted: false });
    await setVoicePushToTalk(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: true, talkHeld: false, muted: false });
    await setVoiceTalking(HOME, true);
    // Turned off while the key is held: it stays open, and the key is forgotten.
    await setVoicePushToTalk(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: false, talkHeld: false });
    // Only the key's gate moved, never a mute, and nothing chimed.
    expect(invoked.map((call) => [call.cmd, call.args.closed])).toEqual([
      ["voice_push_to_talk", false],
      ["voice_push_to_talk", true],
      ["voice_push_to_talk", false],
    ]);
    expect(played).toEqual([]);
  });

  it("a mute you chose survives turning push-to-talk off, and on (#231)", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    await setVoiceMuted(HOME, true);
    await setVoicePushToTalk(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: false, muted: true });
    expect(invoked.filter((call) => call.cmd === "voice_controls").at(-1)?.args.controls).toEqual({ muted: true, deafened: false });
    await setVoicePushToTalk(HOME, true);
    await setVoiceTalking(HOME, true);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: true, muted: true });
    await setVoiceMuted(HOME, false);
    expect(serverState(HOME).myVoice).toMatchObject({ pushToTalk: true, talkHeld: true, muted: false });
  });

  it("turning push-to-talk on or off out of voice changes nothing but the next join", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    expect(serverState(HOME).myVoice).toBeNull();
    invoked.length = 0;
    await setVoicePushToTalk(HOME, true);
    expect(invoked).toEqual([]);
    expect(serverState(HOME).myVoice).toBeNull();
  });

  it("the key does nothing with push-to-talk off", async () => {
    await seated(HOME);
    invoked.length = 0;
    await setVoiceTalking(HOME, true);
    await setVoiceTalking(HOME, false);
    expect(invoked).toEqual([]);
    expect(serverState(HOME).myVoice).toMatchObject({ talkHeld: false, muted: false });
  });

  it("serializes rapid controls and leaves after a failed native control", async () => {
    await seated(HOME);
    await Promise.all([setVoiceDeafened(HOME, true), setVoiceMuted(HOME, false), setVoiceDeafened(HOME, false)]);
    expect(serverState(HOME).myVoice).toMatchObject({ muted: false, deafened: false });
    failing.add("voice_controls");
    await expect(setVoiceDeafened(HOME, true)).rejects.toThrow(/disconnected/);
    expect(serverState(HOME).myVoice).toBeNull();
    expect(invoked.at(-1)?.cmd).toBe("voice_leave");
  });

  it("keeps deafen when moving, but starts fresh after leaving", async () => {
    await seated(HOME);
    await setVoiceDeafened(HOME, true);
    await joinVoice(fakeApi(HOME), "r-porch", DEFAULTS, false);
    expect(serverState(HOME).myVoice).toMatchObject({ roomId: "r-porch", muted: true, deafened: true });
    await leaveVoice(HOME);
    await joinVoice(fakeApi(HOME), "r-porch", DEFAULTS, false);
    expect(serverState(HOME).myVoice).toMatchObject({ muted: false, deafened: false });
  });

  it("plays live voice arrivals and departures, not controls or replay", async () => {
    await seated(HOME);
    expect(played).toEqual([]);
    const together = voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "friend"]]);
    arrive(HOME, together);
    expect(played).toEqual(["voice-join"]);
    arrive(HOME, together);
    expect(played).toHaveLength(1);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"]]));
    expect(played.at(-1)).toBe("peer-leave");
    handlers.get("gateway:frame")?.({ payload: { server: HOME, frame: together, replayed: true } });
    expect(played).toHaveLength(2);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"], ["s-1", "friend"], ["s-2", "other"]]));
    expect(played.at(-1)).toBe("peer-join");
  });

  it("push-to-talk is silent; deliberate controls chime only after success", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    await setVoiceTalking(HOME, true);
    await setVoiceTalking(HOME, false);
    expect(played).toEqual([]);
    await setVoiceDeafened(HOME, true);
    await setVoiceDeafened(HOME, false);
    expect(played).toEqual(["deafen", "undeafen"]);
    failing.add("voice_controls");
    await expect(setVoiceDeafened(HOME, true)).rejects.toThrow();
    expect(played).toHaveLength(2);
  });

  it("a control pressed in another window hands back its sound, once applied, and plays nothing here (#241)", async () => {
    await seated(HOME);
    const controls = () => invoked.filter((call) => call.cmd === "voice_controls").length;
    const before = controls();
    await expect(setVoiceMuted(HOME, true, false)).resolves.toBe("mute");
    expect(controls()).toBe(before + 1);
    expect(serverState(HOME).myVoice?.muted).toBe(true);
    // Nothing changed, so nothing to confirm.
    await expect(setVoiceMuted(HOME, true, false)).resolves.toBeNull();
    await expect(setVoiceDeafened(HOME, true, false)).resolves.toBe("deafen");
    await expect(setVoiceDeafened(HOME, false, false)).resolves.toBe("undeafen");
    await expect(setVoiceMuted(HOME, false, false)).resolves.toBe("unmute");
    expect(played).toEqual([]);
    // The list window's own controls still sound where they were pressed.
    await expect(setVoiceMuted(HOME, true)).resolves.toBe("mute");
    expect(played).toEqual(["mute"]);
    // A change the core refuses has nothing to confirm.
    failing.add("voice_controls");
    await expect(setVoiceDeafened(HOME, true, false)).rejects.toThrow(/disconnected/);
    expect(played).toEqual(["mute"]);
  });

  it("leaving hands back its sound once voice has stopped, and only when you were in voice (#241)", async () => {
    await seated(HOME);
    await expect(leaveVoice(HOME, false)).resolves.toBe("voice-leave");
    expect(invoked.at(-1)?.cmd).toBe("voice_leave");
    expect(played).toEqual([]);
    await expect(leaveVoice(HOME, false)).resolves.toBeNull();
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    await expect(leaveVoice(HOME)).resolves.toBe("voice-leave");
    expect(played).toEqual(["voice-leave"]);
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    played.length = 0;
    failing.add("voice_leave");
    await expect(leaveVoice(HOME, false)).rejects.toThrow();
    expect(played).toEqual([]);
  });

  it("moving has one arrival cue and observers outside voice never ring", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    arrive(HOME, voiceState("r-garage", [["s-1", "friend"]]));
    expect(played).toEqual([]);
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, false);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"]]));
    played.length = 0;
    await joinVoice(fakeApi(HOME), "r-porch", DEFAULTS, false);
    expect(played).toEqual([]);
    arrive(HOME, voiceState("r-porch", [["s-me", "u-matt"], ["s-1", "friend"]]));
    expect(played).toEqual(["voice-move"]);
    await setVoiceMuted(HOME, true);
    await setVoiceMuted(HOME, false);
    expect(played.slice(-2)).toEqual(["mute", "unmute"]);
  });

  it("a fresh ready is a fresh session, so the seat and the lists go with it", async () => {
    await seated(HOME);
    arrive(HOME, voiceState("r-garage", [["s-me", "u-matt"]]));

    arrive(HOME, ready({ session_id: "s-me-2" }));

    expect(serverState(HOME).sessionId).toBe("s-me-2");
    expect(serverState(HOME).myVoice).toBeNull();
    expect(serverState(HOME).voice).toEqual({});
  });
});
