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
import { ask } from "./bus";
import { CLOSED, NOTIFY, type Outcome, PASSWORD } from "./share";

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
// What the owner tells the notifier you're looking at, newest last.
const viewed = vi.hoisted(() => [] as unknown[]);
vi.mock("../../lib/notify", () => ({ considerFrame: () => undefined, setViewing: (at: unknown) => viewed.push(at) }));
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
    heldToken: () => ({ token: tokens[issued] ?? "exhausted", expiresAt: Date.now() + 600_000 }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    changePassword: vi.fn(async (_request: { current_password: string }) => undefined),
    post: vi.fn(async () => undefined),
    get: vi.fn(async () => []),
  };
  return api;
}

/** The owner and one viewer; `viewerLabel` is the viewer's window (`chat`, the tabs, by default). */
async function windows(viewerLabel = "chat") {
  const { memoryHub } = await import("./bus.memory");
  const hub = memoryHub();

  vi.resetModules();
  const owner = {
    gateway: await import("../../lib/gateway"),
    // The owner's own copy, so a refusal built here is one it recognises.
    api: await import("../../lib/api"),
    share: await import("./share"),
    presence: await import("../../lib/watchPresence"),
    bus: hub.bus("main"),
  };
  vi.resetModules();
  const viewer = {
    gateway: await import("../../lib/gateway"),
    mirror: await import("./mirror"),
    bus: hub.bus(viewerLabel),
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

  it("tells the notifier what you're reading only while its window has focus", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);
    viewed.length = 0;

    await follower.intend({ kind: "room", server: HOME, roomId: "r-general" });
    await follower.intend({ kind: "window", focused: true, input: true });
    await vi.waitFor(() => expect(viewed.at(-1)).toEqual({ server: HOME, roomId: "r-general" }));
    // Over to the list, or another app: a message there should reach you again.
    await follower.intend({ kind: "window", focused: false, input: false });
    await vi.waitFor(() => expect(viewed.at(-1)).toBeNull());
    await follower.intend({ kind: "window", focused: true, input: true });
    await vi.waitFor(() => expect(viewed.at(-1)).toEqual({ server: HOME, roomId: "r-general" }));
    // Gone without a word: nothing is being read.
    await viewer.bus.send("main", CLOSED, viewer.bus.label);
    await vi.waitFor(() => expect(viewed.at(-1)).toBeNull());
    sharing.stop();
    follower.stop();
  });

  it("does what Settings asks of the owner: rules, a password change, Settings itself and signing out", async () => {
    const { owner, viewer, core } = await windows("settings");
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const done: string[] = [];
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]), {
      opener: { chat: () => undefined, conversation: () => undefined, settings: (section) => done.push(`settings ${section ?? "-"}`) },
      accounts: {
        reauthenticate: async (server, auth) => void done.push(`signed back in to ${server} as ${auth.user.username}`),
        signOut: async (server) => void done.push(`signed out of ${server}`),
      },
    });
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);
    /** The error the real API throws for a refusal, with the server's words. */
    const refusal = (status: number, message: string) => new owner.api.ApiError(status, { code: "UNAUTHENTICATED", message, retry_after_ms: null });
    api.changePassword.mockImplementation(async (request) => {
      if (request.current_password !== "old-secret") throw refusal(401, "That isn't your current password.");
    });

    // A rule: saved by the owner, and every window learns it.
    const rule = { target_user_id: "u-eli", room_id: null };
    const on = await ask<Outcome>(viewer.bus, "main", NOTIFY, { server: HOME, rule, on: true });
    expect(on).toEqual({ problem: null });
    expect(api.put).toHaveBeenCalledWith("/me/notify-rules", rule);
    await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).notifyRules).toEqual([rule]));
    api.delete.mockRejectedValueOnce(refusal(500, "The server is busy."));
    expect(await ask<Outcome>(viewer.bus, "main", NOTIFY, { server: HOME, rule, on: false })).toEqual({ problem: "The server is busy." });

    // A password change, then signing straight back in with the new one.
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetched.push(`${init.method} ${url} ${String(init.body)}`);
      const user = { ...owner.gateway.serverState(HOME).me };
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 600, user }), { status: 200 });
    });
    const wrong = await ask<Outcome>(viewer.bus, "main", PASSWORD, { server: HOME, current: "nope", next: "new-secret-1" });
    expect(wrong).toEqual({ problem: "That isn't your current password." });
    expect(fetched).toEqual([]);
    const right = await ask<Outcome>(viewer.bus, "main", PASSWORD, { server: HOME, current: "old-secret", next: "new-secret-1" });
    expect(right).toEqual({ problem: null });
    expect(fetched).toEqual([`POST ${HOME}/api/v1/auth/login {"username":"matt","password":"new-secret-1"}`]);
    vi.unstubAllGlobals();

    await follower.intend({ kind: "settings", section: "invites" });
    await follower.intend({ kind: "signout", server: HOME });
    await follower.intend({ kind: "signout", server: "https://elsewhere.example" });
    await vi.waitFor(() =>
      expect(done).toEqual([`signed back in to ${HOME} as matt`, "settings invites", `signed out of ${HOME}`]),
    );
    sharing.stop();
    follower.stop();
  });

  it("going away from Settings goes through the owner's presence, and so does coming back", async () => {
    const { owner, viewer, core } = await windows("settings");
    const presence = owner.presence;
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]));
    const stopPresence = presence.startPresence();
    evening().slice(0, 3).forEach(core);
    presence.setPresenceLive(HOME, true);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    await follower.intend({ kind: "away", server: HOME, message: "walking the dog" });
    await vi.waitFor(() => expect(JSON.stringify(sentFrames().at(-1))).toContain("walking the dog"));
    await follower.intend({ kind: "away", server: "https://elsewhere.example", message: "not here" });
    await follower.intend({ kind: "away", server: HOME, message: null });
    await vi.waitFor(() => expect(JSON.stringify(sentFrames().at(-1))).not.toContain("walking the dog"));
    expect(JSON.stringify(sentFrames())).not.toContain("not here");
    stopPresence();
    sharing.stop();
    follower.stop();
  });

  it("takes you out of the room when the chat window goes, even if it never said so", async () => {
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
    // The desktop shell reports the window gone (a crash, or the desktop's own close).
    await viewer.bus.send("main", CLOSED, viewer.bus.label);
    await vi.waitFor(() => expect(sentFrames().at(-1)).toEqual({ op: "room.focus", d: { room_id: null } }));
    stopPresence();
    follower.stop();
  });

  it("pops a tab out into its own window, sends it back, and shows a popped-out conversation in its window", async () => {
    // The viewer here is the popped-out window itself.
    const { owner, viewer, core } = await windows("chat-5f1e");
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const opened: string[] = [];
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]), {
      opener: {
        chat: (server, roomId) => opened.push(`chat ${server} ${roomId}`),
        conversation: (server, roomId, kind) => opened.push(`own ${server} ${roomId} ${kind}`),
        settings: (section) => opened.push(`settings ${section ?? ""}`),
      },
    });
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);

    // Nothing popped out: the list opens conversations as tabs.
    sharing.open(HOME, "r-general");
    expect(opened).toEqual([`chat ${HOME} r-general`]);

    await follower.intend({ kind: "popout", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(opened.at(-1)).toBe(`own ${HOME} r-general room`));
    // Once that window shows it, opening it from the list brings that window forward.
    await follower.intend({ kind: "room", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => {
      sharing.open(HOME, "r-general");
      expect(opened.at(-1)).toBe(`own ${HOME} r-general room`);
    });

    await follower.intend({ kind: "tabs", server: HOME, roomId: "r-general" });
    await vi.waitFor(() => expect(opened.at(-1)).toBe(`chat ${HOME} r-general`));
    // Nobody can pop out a conversation on a server the owner isn't signed in to, or one that doesn't exist.
    const before = opened.length;
    await follower.intend({ kind: "popout", server: "https://elsewhere.example", roomId: "r-general" });
    await follower.intend({ kind: "popout", server: HOME, roomId: "r-nowhere" });
    await new Promise((settle) => setTimeout(settle, 20));
    expect(opened).toHaveLength(before);
    sharing.stop();
    follower.stop();
  });

  it("switching to windows opens every conversation in its own window, and every window hears of it", async () => {
    const { owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const opened: string[] = [];
    const items = new Map<string, string>();
    const store = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]), {
      opener: {
        chat: (_server, roomId) => opened.push(`chat ${roomId}`),
        conversation: (_server, roomId, kind) => opened.push(`own ${roomId} ${kind}`),
        settings: () => undefined,
      },
      store,
    });
    evening().slice(0, 3).forEach(core);
    const follower = await viewer.mirror.followOwner(viewer.bus);
    const heard: unknown[] = [];
    await viewer.bus.listen(owner.share.MODE, (message) => heard.push(message));

    await follower.intend({ kind: "conversations", mode: "windows" });
    await vi.waitFor(() => expect(heard).toEqual([{ v: 1, mode: "windows" }]));
    expect(items.get("linger.next.conversations")).toBe("windows");
    sharing.open(HOME, "r-general");
    expect(opened).toEqual(["own r-general room"]);

    // Something that isn't a mode changes nothing.
    await follower.intend({ kind: "conversations", mode: "stacked" as never });
    await follower.intend({ kind: "conversations", mode: "tabs" });
    await vi.waitFor(() => expect(heard).toEqual([{ v: 1, mode: "windows" }, { v: 1, mode: "tabs" }]));
    sharing.open(HOME, "r-general");
    expect(opened.at(-1)).toBe("chat r-general");
    sharing.stop();
    follower.stop();
  });

  it("keeps what the tabs window was sent before it was listening, and hands it over once", async () => {
    const { hub, owner, viewer, core } = await windows();
    const api = fakeOwnerApi(["token-1"]);
    await owner.gateway.connect(api as never);
    const opened: string[] = [];
    const sharing = await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, api as never]]), {
      opener: { chat: (_server, roomId) => opened.push(roomId), conversation: () => undefined, settings: () => undefined },
    });
    evening().slice(0, 3).forEach(core);
    const opens = (label = "chat") => ask<{ opens: unknown[] }>(label === "chat" ? viewer.bus : hub.bus(label), "main", owner.share.OPENS, {});

    // Two rooms clicked while the tabs window is still catching up, and one
    // coming back from a window of its own.
    sharing.open(HOME, "r-general");
    sharing.open(HOME, "r-weekend");
    const follower = await viewer.mirror.followOwner(viewer.bus);
    await follower.intend({ kind: "tabs", server: HOME, roomId: "r-listening" });
    await vi.waitFor(() => expect(opened).toEqual(["r-general", "r-weekend", "r-listening"]));

    // Another window asking is told nothing, and takes nothing.
    await expect(opens("settings")).resolves.toEqual({ opens: [] });
    // Listening now: every one of them, in order, and only once.
    await expect(opens()).resolves.toEqual({
      opens: [
        { server: HOME, roomId: "r-general" },
        { server: HOME, roomId: "r-weekend" },
        { server: HOME, roomId: "r-listening" },
      ],
    });
    await expect(opens()).resolves.toEqual({ opens: [] });
    // While it listens, the shell's own delivery is enough.
    sharing.open(HOME, "r-general");
    await expect(opens()).resolves.toEqual({ opens: [] });

    // Closed: a new tabs window starts from nothing, and missed opens are kept again.
    hub.broadcast(owner.share.CLOSED, "chat");
    sharing.open(HOME, "r-weekend");
    await expect(opens()).resolves.toEqual({ opens: [{ server: HOME, roomId: "r-weekend" }] });
    sharing.stop();
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

  it("a server that isn't answering holds up neither the other servers nor the window", async () => {
    const { owner, viewer, core } = await windows();
    const AWAY = "https://away.example";
    const home = fakeOwnerApi(["token-1"]);
    // Its token has run out and renewing it never comes back.
    const away = {
      ...fakeOwnerApi([]),
      baseUrl: AWAY,
      accessToken: vi.fn(() => new Promise<never>(() => undefined)),
      heldToken: () => ({ token: "away-held", expiresAt: Date.now() - 1_000 }),
    };
    await owner.gateway.connect(home as never);
    await owner.share.shareAsOwner(
      owner.bus,
      () =>
        new Map([
          [HOME, home as never],
          [AWAY, away as never],
        ]),
    );
    evening().slice(0, 3).forEach(core);
    vi.useRealTimers();
    const opened = Date.now();
    const follower = await viewer.mirror.followOwner(viewer.bus);
    // It waited for the renewal only so long, and got both servers.
    expect(Date.now() - opened).toBeLessThan(owner.share.LEND_WAIT_MS + 1_000);
    await expect(follower.apis.get(HOME)?.accessToken()).resolves.toMatchObject({ token: "token-1" });
    expect(follower.apis.get(AWAY)?.heldToken()).toMatchObject({ token: "away-held" });
    expect(viewer.gateway.serverState(HOME).me?.id).toBe("u-matt");
    follower.stop();
  }, 6_000);

  it("a list window that can't answer says so at once, rather than leaving the window to time out", async () => {
    const { hub } = await windows();
    const { answer } = await import("./bus");
    await answer(hub.bus("main"), "next:test", async () => {
      throw new Error("the keyring is locked");
    });
    vi.useRealTimers();
    const asked = Date.now();
    await expect(ask(hub.bus("chat-2"), "main", "next:test", {})).rejects.toThrow("main couldn't answer next:test: the keyring is locked");
    expect(Date.now() - asked).toBeLessThan(1_000);
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
