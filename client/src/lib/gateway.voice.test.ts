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

vi.mock("../notify/notify", () => ({ considerFrame: () => undefined }));
const played: string[] = [];
vi.mock("./sound", () => ({ playKnock: () => false, playSound: (cue: string) => { played.push(cue); return true; } }));

const {
  connect,
  disconnect,
  joinVoice,
  leaveVoice,
  serverState,
  setVoiceMuted,
  setVoiceDeafened,
  setVoiceVolume,
  voicePeersIn,
} = await import("./gateway");

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

function voiceState(roomId: string, seats: [string, string][]): ServerFrame {
  return {
    s: 2,
    op: "voice.state",
    d: {
      room_id: roomId,
      peers: seats.map(([session_id, user_id]) => ({ session_id, user_id })),
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

  it("joins with the session id and the chosen devices, muting first for push-to-talk", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    invoked.length = 0;

    await joinVoice(fakeApi(HOME), "r-garage", { input: "USB Mic", output: null }, true);

    const calls = invoked.filter((call) => call.cmd.startsWith("voice_"));
    expect(calls.map((call) => call.cmd)).toEqual(["voice_controls", "voice_join"]);
    expect(calls[0]?.args).toEqual({ baseUrl: HOME, controls: { muted: true, deafened: false } });
    expect(calls[1]?.args).toEqual({
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
      muted: true,
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

  it("folds the core's own events into the seat, and ignores them without one", async () => {
    await seated(HOME);

    coreEvent("voice:peer", { server: HOME, peer: "s-1", state: "connected" });
    coreEvent("voice:audio", { server: HOME, state: "sending" });
    coreEvent("voice:speaking", { server: HOME, peer: "s-1", speaking: true });
    coreEvent("voice:speaking", { server: HOME, peer: null, speaking: true });

    expect(serverState(HOME).myVoice).toMatchObject({
      peers: { "s-1": "connected" },
      audio: "sending",
      speaking: { "s-1": true },
      talking: true,
    });

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

  it("push-to-talk stays muted after undeafen, even if its key was held", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready());
    await joinVoice(fakeApi(HOME), "r-garage", DEFAULTS, true);
    await setVoiceMuted(HOME, false);
    await setVoiceDeafened(HOME, true);
    await setVoiceMuted(HOME, false);
    await setVoiceDeafened(HOME, false);
    expect(serverState(HOME).myVoice?.muted).toBe(true);
    await setVoiceMuted(HOME, false);
    expect(serverState(HOME).myVoice?.muted).toBe(false);
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
    await setVoiceMuted(HOME, false);
    await setVoiceMuted(HOME, true);
    expect(played).toEqual([]);
    await setVoiceDeafened(HOME, true);
    await setVoiceDeafened(HOME, false);
    expect(played).toEqual(["deafen", "undeafen"]);
    failing.add("voice_controls");
    await expect(setVoiceDeafened(HOME, true)).rejects.toThrow();
    expect(played).toHaveLength(2);
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
