/**
 * Two windows, one connection (docs/design/architecture.md): the owner
 * connects and folds frames as today's client does; a viewer opens partway
 * through, catches up from the owner's snapshot over the bus, borrows its
 * sign-in, and asks it to do what only it may. Each window is its own copy of
 * the store module, as each Tauri window is its own page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../generated/Message";
import type { Room } from "../../generated/Room";
import type { ServerFrame } from "../../generated/ServerFrame";
import type { User } from "../../generated/User";

// What the Rust core's `app.emit` reaches in the owner: the store's own
// listeners (today's client's path, unchanged).
type Handler = (event: { payload: unknown }) => void;
const ownerCore = new Map<string, Handler>();

// Every command the pages send to the core, so a test can see what reached the wire.
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    return true;
  },
}));

/** Frames the owner sent upstream through the core. */
function sentFrames(): unknown[] {
  return invoked.filter((call) => call.cmd === "gateway_send").map((call) => call.args.frame);
}
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler) => {
    ownerCore.set(name, handler);
    return () => ownerCore.delete(name);
  },
  emit: async () => undefined,
  emitTo: async () => undefined,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main", listen: async () => () => undefined }) }));
vi.mock("../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const HOME = "https://home.example";

function person(id: string, name: string): User {
  return {
    id,
    username: name,
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function room(id: string): Room {
  return { id, slug: id, name: id, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null };
}

function message(at: number): Message {
  return {
    id: `m${String(at).padStart(6, "0")}`,
    room_id: "r-general",
    author_id: "u-eli",
    body: `message ${at}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: at,
  };
}

/** An evening: a snapshot, then people coming and going and talking, then a re-identify. */
function evening(): ServerFrame[] {
  const matt = person("u-matt", "matt");
  const eli = person("u-eli", "eli");
  const frames: ServerFrame[] = [];
  const epoch = (session: string, from: number) => {
    let s = 1;
    frames.push({ s, op: "ready", d: { session_id: session, user: matt, users: [matt, eli], rooms: [room("r-general")], dms: [], presence: [] } });
    for (let at = from; at < from + 8; at += 1) {
      s += 1;
      // A knock is the frame that shows a mistake: applying it twice is two
      // cards, where a presence or message frame applied twice looks the same.
      frames.push(
        at % 4 === 1
          ? { s, op: "knock", d: { from_user_id: "u-eli" } }
          : at % 2 === 0
            ? { s, op: "message.create", d: message(at) }
            : { s, op: "presence.update", d: { user_id: "u-eli", state: at % 3 === 0 ? "away" : "in_room", room_id: at % 3 === 0 ? null : "r-general", away_message: null } },
      );
    }
  };
  epoch("session-a", 10);
  epoch("session-b", 30);
  return frames;
}

function fakeOwnerApi(tokens: string[]) {
  let issued = 0;
  const api = {
    baseUrl: HOME,
    accessToken: vi.fn(async (force = false) => {
      if (force) issued += 1;
      return { token: tokens[issued] ?? "exhausted", expiresAt: Date.now() + 600_000 };
    }),
    put: vi.fn(async () => undefined),
    post: vi.fn(async () => undefined),
    get: vi.fn(async () => []),
  };
  return api;
}

async function windows() {
  const { memoryHub } = await import("./bus.memory");
  const hub = memoryHub();

  vi.resetModules();
  const owner = {
    gateway: await import("../../lib/gateway"),
    share: await import("./share"),
    presence: await import("../../lib/watchPresence"),
    bus: hub.bus("main"),
  };
  vi.resetModules();
  const viewer = {
    gateway: await import("../../lib/gateway"),
    mirror: await import("./mirror"),
    bus: hub.bus("chat"),
  };

  /** The Rust core emitting one frame: every window receives it, in order. */
  const core = (frame: ServerFrame) => {
    ownerCore.get("gateway:frame")?.({ payload: { server: HOME, frame } });
    hub.broadcast("gateway:frame", { server: HOME, frame });
  };
  return { hub, owner, viewer, core };
}

describe("a viewer window sharing the owner's connection", () => {
  beforeEach(() => {
    ownerCore.clear();
    invoked.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T22:52:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const openAt of [0, 1, 4, 9, 10, 13, 18]) {
    it(`ends in the owner's exact state when it opens after ${openAt} frames`, async () => {
      const { owner, viewer, core } = await windows();
      const api = fakeOwnerApi(["token-1", "token-2"]);
      await owner.gateway.connect(api as never);
      await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));

      const frames = evening();
      frames.slice(0, openAt).forEach(core);
      const following = viewer.mirror.followOwner(viewer.bus);
      // Frames keep arriving while the viewer is asking and being answered.
      frames.slice(openAt, openAt + 3).forEach(core);
      const follower = await following;
      frames.slice(openAt + 3).forEach(core);

      const strip = (state: ReturnType<typeof owner.gateway.serverState>) => ({ ...state, streams: {} });
      expect(strip(viewer.gateway.serverState(HOME))).toEqual(strip(owner.gateway.serverState(HOME)));
      expect(viewer.gateway.positionOf(HOME)).toEqual(owner.gateway.snapshotOf(HOME).position);
      follower.stop();
    });
  }

  it("applies a frame delivered to it twice only once", async () => {
    const { owner, viewer, core, hub } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    const knock: ServerFrame = { s: 4, op: "knock", d: { from_user_id: "u-eli" } };
    hub.broadcast("gateway:frame", { server: HOME, frame: knock });
    hub.broadcast("gateway:frame", { server: HOME, frame: knock });
    expect(viewer.gateway.serverState(HOME).knocks).toHaveLength(1);
    follower.stop();
  });

  it("borrows the owner's access token and asks for a new one when it stops working", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1", "token-2"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    const borrowed = follower.apis.get(HOME);
    expect(borrowed).toBeDefined();
    await expect(borrowed?.accessToken()).resolves.toMatchObject({ token: "token-1" });
    expect(() => borrowed?.refreshToken).toThrow("a borrowed sign-in has no refresh token");

    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    fetcher
      .mockResolvedValueOnce(Response.json({ error: { code: "UNAUTHENTICATED", message: "expired", retry_after_ms: null } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json([]));
    await expect(borrowed?.dms()).resolves.toEqual([]);
    // The owner renewed once, because the viewer named the token that failed.
    expect(api.accessToken).toHaveBeenCalledWith(true);
    const sent = new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization");
    expect(sent).toBe("Bearer token-2");
    follower.stop();
  });

  it("marks a room read through the owner, and every window learns the new position", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 9).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);
    expect(owner.gateway.hasNewActivity(owner.gateway.serverState(HOME), "r-general")).toBe(true);

    await follower.intend({ kind: "read", server: HOME, roomId: "r-general", messageId: "m000016" });
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).read["r-general"]).toBe("m000016"));
    expect(owner.gateway.serverState(HOME).read["r-general"]).toBe("m000016");
    expect(owner.gateway.hasNewActivity(owner.gateway.serverState(HOME), "r-general")).toBe(false);
    expect(api.put).toHaveBeenCalledWith("/rooms/r-general/read", { last_read_id: "m000016" });
    follower.stop();
  });

  it("puts you in the room the chat window shows, through the owner's presence", async () => {
    const { owner, viewer, core } = await windows();
    const presence = owner.presence;
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    const stopPresence = presence.startPresence();
    evening().slice(0, 3).forEach(core);
    presence.setPresenceLive(HOME, true);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    await follower.intend({ kind: "window", focused: true, input: true });
    await follower.intend({ kind: "room", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(sentFrames()).toContainEqual({ op: "room.focus", d: { room_id: "r-general" } }));
    stopPresence();
    follower.stop();
  });

  it("joins, talks and leaves voice through the owner, and every window sees the seat", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    await follower.intend({ kind: "voice.join", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(invoked.map((call) => call.cmd)).toContain("voice_join"));
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).myVoice?.roomId).toBe("r-general"));
    expect(owner.gateway.serverState(HOME).myVoice?.roomId).toBe("r-general");

    await follower.intend({ kind: "voice.mute", muted: true });
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).myVoice?.muted).toBe(true));

    await follower.intend({ kind: "voice.leave" });
    await vi.waitFor(() => expect(invoked.map((call) => call.cmd)).toContain("voice_leave"));
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).myVoice).toBeNull());
    expect(owner.gateway.serverState(HOME).myVoice).toBeNull();
    follower.stop();
  });

  it("push-to-talk opens the microphone only while the key is held, and only when it is on", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);
    const controls = () => invoked.filter((call) => call.cmd === "voice_controls").map((call) => call.args.controls);

    // Push-to-talk off: the key does nothing to the microphone.
    await follower.intend({ kind: "voice.join", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(owner.gateway.serverState(HOME).myVoice?.audio).toBeDefined());
    const before = controls().length;
    await follower.intend({ kind: "voice.talk", down: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controls().length).toBe(before);
    expect(owner.gateway.serverState(HOME).myVoice?.muted).toBe(false);
    follower.stop();
  });

  it("with push-to-talk on, the key held in the chat window opens the microphone and letting go closes it", async () => {
    const saved = new Map([["linger.voice.pushToTalk", "true"]]);
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: () => undefined } });
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    await follower.intend({ kind: "voice.join", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(owner.gateway.serverState(HOME).myVoice?.pushToTalk).toBe(true));
    expect(owner.gateway.serverState(HOME).myVoice?.muted).toBe(true);

    await follower.intend({ kind: "voice.talk", down: true });
    await vi.waitFor(() => expect(owner.gateway.serverState(HOME).myVoice?.muted).toBe(false));
    await follower.intend({ kind: "voice.talk", down: false });
    await vi.waitFor(() => expect(owner.gateway.serverState(HOME).myVoice?.muted).toBe(true));
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).myVoice?.muted).toBe(true));
    follower.stop();
  });

  it("gives up clearly when there is no owner to answer", async () => {
    const { viewer } = await windows();
    vi.useRealTimers();
    await expect(
      Promise.race([
        viewer.mirror.followOwner(viewer.bus),
        new Promise((_, reject) => setTimeout(() => reject(new Error("the viewer hung instead of giving up")), 5_500)),
      ]),
    ).rejects.toThrow("no answer to next:snapshot from main");
  }, 8_000);
});
