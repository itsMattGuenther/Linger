/**
 * The store holds one server's world per server, and does not mix them up.
 *
 * This is the part of T-412 that would fail silently. Two servers have their
 * own rooms, their own people and their own read markers, and every one of
 * those is keyed by an id that means nothing on the other server. A frame
 * folded into the wrong snapshot would look like a room appearing out of
 * nowhere — no error, no failing request, just the wrong thing on screen.
 *
 * The Tauri core is mocked down to what this file actually talks to: the two
 * events it listens for, and the commands it sends. That is enough to push
 * frames at one server and prove the other never saw them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomEmoji } from "../generated/CustomEmoji";
import type { Message } from "../generated/Message";
import type { ReadyData } from "../generated/ReadyData";
import type { Room } from "../generated/Room";
import type { ServerFrame } from "../generated/ServerFrame";
import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "./api";

/** Every command the store sent down to the core, in order. */
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: Record<string, unknown>): Promise<boolean> => {
    invoked.push({ cmd, args });
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

// The notifier reaches for a notification plugin and a markdown parser, and
// neither has anything to do with which snapshot a frame lands in.
vi.mock("./notify", () => ({ considerFrame: () => undefined }));

// The sound player reaches for an `AudioContext` that a test runner does not
// have. Whether a knock makes a noise is `sound.test.ts`'s question; this file
// is about where the card ends up.
vi.mock("./sound", () => ({ playKnock: () => false, playSound: () => false }));

const {
  connect,
  disconnect,
  dismissKnock,
  hasNewActivity,
  loadBlocks,
  loadReports,
  KNOCK_TTL_MS,
  leaveWindow,
  loadNewer,
  loadNotifyRules,
  loadOlder,
  loadReadMarkers,
  flushReadMarkers,
  markRead,
  openAround,
  openRoom,
  releaseOtherRooms,
  send,
  sendMessage,
  serverState,
  setBlocked,
  trimHistory,
} = await import("./gateway");

const HOME = "https://home.example";
const WORK = "https://work.example";

/**
 * Just enough of an `AuthedApi` for the store: the URL it is filed under, and
 * a token to hand the core. Nothing here makes an HTTP request.
 */
function fakeApi(baseUrl: string, get?: (path: string) => unknown): AuthedApi {
  const stub = {
    baseUrl,
    accessToken: async () => ({ token: `token-${baseUrl}`, expiresAt: 0 }),
    // Only the history tests hand one of these in. Everything else in the
    // store talks to the core, not to HTTP.
    get: async (path: string) => {
      if (!get) throw new Error(`unexpected GET ${path}`);
      return get(path);
    },
  };
  // The store only ever touches those few members; the cast is confined to
  // this helper rather than spread through the tests.
  return stub as unknown as AuthedApi;
}

/**
 * A message id that sorts like a real one. Message ids are UUIDv7 and the
 * store compares them as strings, so a zero-padded counter behaves the same
 * way: `id(9) < id(10)`.
 */
function id(at: number): string {
  return `m${String(at).padStart(6, "0")}`;
}

function message(at: number): Message {
  return {
    id: id(at),
    room_id: "r-garage",
    author_id: "u-matt",
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

/** Newest-first, the way every page from this endpoint arrives. */
function pageOf(from: number, to: number): Message[] {
  const out: Message[] = [];
  for (let at = to; at >= from; at -= 1) out.push(message(at));
  return out;
}

function person(id: string, name: string): User {
  return {
    id,
    username: name,
    display_name: name,
    is_host: false,
    is_cohost: false,
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

function dm(id: string, members: string[], lastMessageId: string | null = null): Room {
  return {
    id,
    slug: `dm-${id}`,
    name: `dm-${id}`,
    topic: null,
    kind: "dm",
    member_ids: members,
    position: 0,
    archived_at: null,
    last_message_id: lastMessageId,
  };
}

function room(id: string, slug: string, lastMessageId: string | null): Room {
  return {
    id,
    slug,
    name: slug,
    topic: null,
    kind: "room",
    member_ids: null,
    position: 0,
    archived_at: null,
    last_message_id: lastMessageId,
  };
}

function ready(data: Partial<ReadyData> & { user: User }): ServerFrame {
  return {
    s: 1,
    op: "ready",
    d: {
      session_id: "session",
      users: [data.user],
      rooms: [],
      dms: [],
      presence: [],
      ...data,
    },
  };
}

/** Push one frame up from the core, as if it had arrived on that server. */
function arrive(server: string, frame: ServerFrame): void {
  handlers.get("gateway:frame")?.({ payload: { server, frame } });
}

function statusOf(server: string, status: unknown): void {
  handlers.get("gateway:status")?.({ payload: { server, status } });
}

describe("what's fetched alongside a connection that's opening", () => {
  beforeEach(async () => {
    await disconnect(HOME);
  });

  // A server on the same machine (the phone app against a local server)
  // answers before the connection has opened, and opening starts the
  // server's state afresh. The answer was dropped, and a conversation then
  // waited for read positions that never came.
  it("keeps read positions that came back before the connection opened", async () => {
    const api = fakeApi(HOME, () => ({ "r-garage": id(7) }));
    const loading = loadReadMarkers(api);
    await Promise.all([loading, connect(api)]);
    expect(serverState(HOME).readLoaded).toBe(true);
    expect(serverState(HOME).read["r-garage"]).toBe(id(7));
  });

  it("keeps notification rules that came back before the connection opened", async () => {
    const rule = { target_user_id: "u-callie", room_id: null };
    const api = fakeApi(HOME, () => [rule]);
    const loading = loadNotifyRules(api);
    await Promise.all([loading, connect(api)]);
    expect(serverState(HOME).notifyRules).toEqual([rule]);
  });

  it("still drops them for a server signed out of meanwhile", async () => {
    const api = fakeApi(HOME, () => ({ "r-garage": id(7) }));
    await connect(api);
    const loading = loadReadMarkers(api);
    await Promise.all([loading, disconnect(HOME)]);
    expect(serverState(HOME).readLoaded).toBe(false);
  });
});

describe("read positions (#453, #454)", () => {
  const matt = person("u-matt", "Matt");

  beforeEach(async () => {
    await disconnect(HOME);
    vi.useRealTimers();
  });

  /** An API whose `GET /read` answers from `answers` in turn: a value, or an `Error` to fail with. */
  function readApi(answers: unknown[], puts: { path: string; body: unknown }[] = []): AuthedApi {
    let asked = 0;
    const stub = {
      baseUrl: HOME,
      accessToken: async () => ({ token: "token", expiresAt: 0 }),
      get: async (path: string) => {
        if (path !== "/read") throw new Error(`unexpected GET ${path}`);
        const answer = answers[Math.min(asked, answers.length - 1)];
        asked += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      put: async (path: string, body: unknown) => {
        puts.push({ path, body });
      },
    };
    return stub as unknown as AuthedApi;
  }

  it("keeps the later of the server's position and this device's, room by room", async () => {
    const api = readApi([{ "r-garage": id(9), "r-porch": id(3) }]);
    await connect(api);
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", id(9)), room("r-porch", "porch", id(5))] }));
    // Said here, so read here; the server hears of r-porch's from the post itself.
    arrive(HOME, { s: 2, op: "message.create", d: { ...message(4), room_id: "r-garage" } });
    arrive(HOME, { s: 3, op: "message.create", d: { ...message(5), room_id: "r-porch" } });

    await loadReadMarkers(api);

    // Read on another device up to 9: this device's 4 is behind it.
    expect(serverState(HOME).read["r-garage"]).toBe(id(9));
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(false);
    // This device is ahead of what the server answered.
    expect(serverState(HOME).read["r-porch"]).toBe(id(5));
  });

  it("asks again when the answer doesn't come, rather than leaving every room looking new", async () => {
    vi.useFakeTimers();
    const api = readApi([new Error("network blocked"), { "r-garage": id(9) }]);
    await connect(api);
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", id(9))] }));

    const loading = loadReadMarkers(api);
    await vi.advanceTimersByTimeAsync(0);
    // A room can be opened meanwhile.
    expect(serverState(HOME).readLoaded).toBe(true);
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    await loading;
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(false);
  });

  it("stops asking for a server signed out of", async () => {
    vi.useFakeTimers();
    let asked = 0;
    const api = fakeApi(HOME, () => {
      asked += 1;
      throw new Error("down");
    });
    await connect(api);
    const loading = loadReadMarkers(api);
    await vi.advanceTimersByTimeAsync(0);
    await disconnect(HOME);
    await vi.advanceTimersByTimeAsync(60_000);
    await loading;
    expect(asked).toBe(1);
  });

  it("sends a position still waiting out its five seconds the moment it's asked to", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      const puts: { path: string; body: unknown }[] = [];
      const api = readApi([{}], puts);
      await connect(api);
      markRead(api, "r-garage", id(1));
      markRead(api, "r-garage", id(2));
      expect(puts.map((put) => put.body)).toEqual([{ last_read_id: id(1) }]);

      // The phone app leaving the screen: Android stops its timers soon after.
      flushReadMarkers();
      expect(puts.map((put) => put.body)).toEqual([{ last_read_id: id(1) }, { last_read_id: id(2) }]);
      // And it isn't sent twice.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(puts).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the gateway store, with two servers", () => {
  beforeEach(async () => {
    await Promise.all([disconnect(HOME), disconnect(WORK)]);
    invoked.length = 0;
  });

  it("dials each server by name", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    const dialled = invoked.filter((call) => call.cmd === "gateway_connect");
    expect(dialled.map((call) => call.args.baseUrl)).toEqual([HOME, WORK]);
  });

  it("folds a frame into the server it came from and no other", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));

    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", null)] }));

    expect(serverState(HOME).rooms.map((r) => r.slug)).toEqual(["garage"]);
    expect(serverState(HOME).me?.display_name).toBe("Matt");
    // Work heard nothing, so it still has nothing.
    expect(serverState(WORK).rooms).toEqual([]);
    expect(serverState(WORK).me).toBeNull();
  });

  it("keeps two servers' connection states apart", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));

    statusOf(HOME, { kind: "ready", latency_ms: 12 });
    statusOf(WORK, { kind: "waiting", retry_in_ms: 4000, reason: "refused" });

    expect(serverState(HOME).status).toEqual({ kind: "ready", latency_ms: 12 });
    expect(serverState(WORK).status.kind).toBe("waiting");
  });

  it("marks a server that is holding something you have not read", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));

    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", "m-9")] }));
    arrive(WORK, ready({ user: matt, rooms: [room("r-standup", "standup", null)] }));

    // A room with a newest message and no read marker is a room with something
    // in it. Still a boolean — nothing here counts anything.
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(true);
    // An empty room is not "something new" on the other server.
    expect(hasNewActivity(serverState(WORK), "r-standup")).toBe(false);
  });

  it("sends a frame to the server it was meant for", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    invoked.length = 0;

    await send(WORK, { op: "typing.start", d: { room_id: "r-standup" } });

    const sends = invoked.filter((call) => call.cmd === "gateway_send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.args.baseUrl).toBe(WORK);
  });

  it("signing out of one server leaves the other exactly where it was", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", null)] }));
    arrive(WORK, ready({ user: matt, rooms: [room("r-standup", "standup", null)] }));

    // Connecting closes whatever that URL had before, so only what happens
    // from here counts as the sign-out.
    invoked.length = 0;
    await disconnect(HOME);

    expect(serverState(HOME).rooms).toEqual([]);
    expect(serverState(HOME).me).toBeNull();
    expect(serverState(WORK).rooms.map((r) => r.slug)).toEqual(["standup"]);
    // And only that server's socket was told to close.
    const closed = invoked.filter((call) => call.cmd === "gateway_disconnect");
    expect(closed.map((call) => call.args.baseUrl)).toEqual([HOME]);
  });

  it("still hears the server that is left after the other one goes", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    await disconnect(HOME);

    const matt = person("u-matt", "Matt");
    arrive(WORK, ready({ user: matt, rooms: [room("r-standup", "standup", null)] }));

    expect(serverState(WORK).rooms.map((r) => r.slug)).toEqual(["standup"]);
  });

  it("survives an effect that connects, disconnects and reconnects at once", async () => {
    // React's StrictMode double-invoke, exactly: create, destroy, create, with
    // nothing awaited in between. This left a live socket in the core with no
    // listener in the WebView — the app said `ready` and then never applied
    // another frame. It was sighted once under T-410 and reproduced under
    // T-412 with two servers signed in.
    const api = fakeApi(HOME);
    await Promise.all([connect(api), disconnect(HOME), connect(api)]);

    const dialling = invoked.filter(
      (call) => call.cmd === "gateway_connect" || call.cmd === "gateway_disconnect",
    );
    expect(dialling.at(-1)?.cmd).toBe("gateway_connect");

    // And the listener still routes, which is the half that used to go quiet.
    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", null)] }));
    expect(serverState(HOME).rooms.map((r) => r.slug)).toEqual(["garage"]);
  });

  it("ends where the last call asked, not where the slowest one did", async () => {
    // Signing out while the connect is still dialling. Unserialized, the
    // half-finished connect lands *after* the disconnect and quietly signs you
    // back in — a socket nobody asked for, on an account that just left.
    const api = fakeApi(HOME);
    const opening = connect(api);
    await disconnect(HOME);
    await opening;

    expect(invoked.filter((call) => call.cmd === "gateway_connect")).not.toHaveLength(0);
    const dialling = invoked.filter(
      (call) => call.cmd === "gateway_connect" || call.cmd === "gateway_disconnect",
    );
    expect(dialling.at(-1)?.cmd).toBe("gateway_disconnect");

    // Nothing is following it, so its frames go nowhere.
    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, rooms: [room("r-garage", "garage", null)] }));
    expect(serverState(HOME).rooms).toEqual([]);
  });

  it("takes a removed member off the roster and leaves the other server alone", async () => {
    // T-413. The card has to go without a reload, and it has to go on this
    // server only — a user id means nothing next to the server it came from.
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    const matt = person("u-matt", "Matt");
    const callie = person("u-callie", "Callie");

    arrive(HOME, ready({ user: matt, users: [matt, callie] }));
    arrive(WORK, ready({ user: matt, users: [matt, callie] }));
    arrive(HOME, {
      s: 2,
      op: "presence.update",
      d: {
        user_id: callie.id,
        state: "around",
        room_id: null,
        away_message: null,
      },
    });

    arrive(HOME, { s: 3, op: "user.remove", d: { user_id: callie.id } });

    expect(serverState(HOME).users.map((person) => person.id)).toEqual([matt.id]);
    expect(serverState(HOME).presence).toEqual([]);
    expect(serverState(WORK).users.map((person) => person.id)).toEqual([matt.id, callie.id]);

    // And letting them back in is the same frame a rename arrives on: the fold
    // appends when the id is unknown, so the card grows back on its own.
    arrive(HOME, { s: 4, op: "user.update", d: callie });
    expect(serverState(HOME).users.map((person) => person.id)).toEqual([matt.id, callie.id]);
  });

  it("drops frames for a server nobody is following", async () => {
    await connect(fakeApi(HOME));
    const matt = person("u-matt", "Matt");

    arrive(WORK, ready({ user: matt, rooms: [room("r-standup", "standup", null)] }));

    expect(serverState(WORK).rooms).toEqual([]);
  });
});

/**
 * Knocks (SPEC §4.9, T-1102).
 *
 * The store is the only place a knock exists — nothing is written down at
 * either end — so these are the tests that prove it arrives, that it can be
 * taken away, and above all that it does not stay.
 */
describe("knocks", () => {
  const matt = person("u-matt", "Matt");
  const callie = person("u-callie", "Callie");

  beforeEach(async () => {
    await Promise.all([disconnect(HOME), disconnect(WORK)]);
    invoked.length = 0;
  });

  it("holds a knock on the server it came from, and names who knocked", async () => {
    await connect(fakeApi(HOME));
    await connect(fakeApi(WORK));
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));

    arrive(HOME, { s: 2, op: "knock", d: { from_user_id: callie.id } });

    expect(serverState(HOME).knocks.map((knock) => knock.from)).toEqual([callie.id]);
    expect(serverState(WORK).knocks).toEqual([]);
  });

  it("keeps two knocks from the same person as two cards", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));

    arrive(HOME, { s: 2, op: "knock", d: { from_user_id: callie.id } });
    arrive(HOME, { s: 3, op: "knock", d: { from_user_id: callie.id } });

    const held = serverState(HOME).knocks;
    expect(held).toHaveLength(2);
    // Distinct ids, or React draws one card and the second knock is invisible.
    expect(new Set(held.map((knock) => knock.id)).size).toBe(2);
  });

  it("takes one away when its card is done, and leaves nothing behind", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));
    arrive(HOME, { s: 2, op: "knock", d: { from_user_id: callie.id } });

    const [knock] = serverState(HOME).knocks;
    expect(knock).toBeDefined();
    dismissKnock(HOME, knock?.id ?? "");

    expect(serverState(HOME).knocks).toEqual([]);
  });

  it("drops a knock that is already older than its card's life", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));

    arrive(HOME, { s: 2, op: "knock", d: { from_user_id: callie.id } });
    // A window that was asleep, or a card whose timer never ran: the stale one
    // must not still be there when the next knock arrives.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + KNOCK_TTL_MS + 1);
    arrive(HOME, { s: 3, op: "knock", d: { from_user_id: matt.id } });
    vi.useRealTimers();

    expect(serverState(HOME).knocks.map((knock) => knock.from)).toEqual([matt.id]);
  });

  it("forgets knocks when the session starts over", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));
    arrive(HOME, { s: 2, op: "knock", d: { from_user_id: callie.id } });

    // A fresh `ready` is a new session. A tap on the shoulder from before the
    // reconnect means nothing now.
    arrive(HOME, ready({ user: matt, users: [matt, callie] }));

    expect(serverState(HOME).knocks).toEqual([]);
  });
});

/**
 * A room opened *at* an old message (SPEC §4.12, T-1203).
 *
 * This is the half of search that can go wrong silently. A window six months
 * back is not the newest page, and every live message that arrives while it is
 * open would, if folded in, sit next to a message from months earlier with
 * nothing between them and nothing to say so. A gap you cannot see is worse
 * than a message that arrives a moment later, so the frames are dropped and
 * reading forwards picks them up.
 *
 * There are 10,000 messages in the fake room, numbered 1 (oldest) to 10,000,
 * which is the size the acceptance criterion names.
 */
describe("a room opened on a search hit", () => {
  const NEWEST = 10_000;
  /** Where the hit is: far from both ends, the case paging cannot reach. */
  const HIT = 1_800;

  /** The room, answering `before` / `around` the way the server does. */
  function history(): (path: string) => Message[] {
    return (path: string) => {
      const url = new URL(`https://x${path}`);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const around = url.searchParams.get("around");
      if (around !== null) {
        const at = Number(around.slice(1));
        const older = Math.ceil(limit / 2);
        const newer = Math.floor(limit / 2);
        // Each half capped on its own, neither borrowing from the other —
        // which is what makes a short half a real edge (PROTOCOL §4).
        return pageOf(Math.max(1, at - older + 1), Math.min(NEWEST, at + newer));
      }
      const before = url.searchParams.get("before");
      const top = before === null ? NEWEST : Number(before.slice(1)) - 1;
      return pageOf(Math.max(1, top - limit + 1), top);
    };
  }

  beforeEach(async () => {
    await disconnect(HOME);
    invoked.length = 0;
  });

  it("lands on the message and knows it is not at the newest", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));

    await openRoom(api, "r-garage");
    // Opened the ordinary way: the newest page, attached to the live socket.
    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(true);

    await openAround(api, "r-garage", id(HIT));
    const stream = serverState(HOME).streams["r-garage"];
    // The hit is here, in one request rather than eighty.
    expect(stream?.messages.some((held) => held.id === id(HIT))).toBe(true);
    // And the newest page it replaced is gone, rather than joined onto it.
    expect(stream?.messages.some((held) => held.id === id(NEWEST))).toBe(false);
    expect(stream?.atEnd).toBe(false);
    expect(stream?.atStart).toBe(false);
    // Oldest first, with no gaps: consecutive ids all the way across.
    const ids = (stream?.messages ?? []).map((held) => held.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("drops a live message rather than leaving a hole in the window", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openAround(api, "r-garage", id(HIT));

    const fresh = message(NEWEST + 1);
    arrive(HOME, { s: 2, op: "message.create", d: fresh } as ServerFrame);

    const stream = serverState(HOME).streams["r-garage"];
    expect(stream?.messages.some((held) => held.id === fresh.id)).toBe(false);
    // But the room still counts as holding something new, because it does —
    // that is tracked beside the history for exactly this reason.
    expect(serverState(HOME).newest["r-garage"]).toBe(fresh.id);
  });

  it("still applies an edit to a message the window holds", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openAround(api, "r-garage", id(HIT));

    const edited = { ...message(HIT), body: "edited", edited_at: 1 };
    arrive(HOME, { s: 2, op: "message.update", d: edited } as ServerFrame);

    const held = serverState(HOME).streams["r-garage"]?.messages.find(
      (one) => one.id === id(HIT),
    );
    expect(held?.body).toBe("edited");
  });

  it("reads forwards out of the window without skipping anything", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openAround(api, "r-garage", id(HIT));

    const before = serverState(HOME).streams["r-garage"];
    const wasNewest = before?.messages[before.messages.length - 1]?.id;

    await loadNewer(api, "r-garage");
    const after = serverState(HOME).streams["r-garage"];
    const ids = (after?.messages ?? []).map((held) => held.id);

    // It moved forwards, it is still in order, and it is still contiguous —
    // no id from the old end is missing and none was skipped past.
    expect((ids[ids.length - 1] ?? "") > (wasNewest ?? "")).toBe(true);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(wasNewest);
    expect(after?.atEnd).toBe(false);
  });

  it("becomes whole again at the end of the room", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    // A hit near the newest message: one read forwards reaches the end.
    await openAround(api, "r-garage", id(NEWEST - 10));

    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(true);
    // Which means live frames land again.
    const fresh = message(NEWEST + 1);
    arrive(HOME, { s: 2, op: "message.create", d: fresh } as ServerFrame);
    expect(
      serverState(HOME).streams["r-garage"]?.messages.some((held) => held.id === fresh.id),
    ).toBe(true);
  });

  it("goes back to the newest when asked", async () => {
    const api = fakeApi(HOME, history());
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openAround(api, "r-garage", id(HIT));

    await leaveWindow(api, "r-garage");
    const stream = serverState(HOME).streams["r-garage"];
    expect(stream?.atEnd).toBe(true);
    expect(stream?.messages.some((held) => held.id === id(NEWEST))).toBe(true);
    expect(stream?.messages.some((held) => held.id === id(HIT))).toBe(false);
  });

  /**
   * The room's history, with every read held until the test answers it, so
   * the test decides the order two reads on the wire together come back in.
   */
  function heldHistory(): { api: AuthedApi; asked: string[]; answer: (part: string) => void } {
    const room = history();
    const asked: string[] = [];
    const waiting: { path: string; go: () => void }[] = [];
    const api = fakeApi(HOME, async (path: string) => {
      asked.push(path);
      await new Promise<void>((go) => waiting.push({ path, go }));
      return room(path);
    });
    const answer = (part: string): void => {
      const at = waiting.findIndex((read) => read.path.includes(part));
      const read = waiting[at];
      if (!read) throw new Error(`nothing waiting for ${part}`);
      waiting.splice(at, 1);
      read.go();
    };
    return { api, asked, answer };
  }

  /** Let every answered read land and fold in. */
  const settle = () => new Promise<void>((done) => setTimeout(done, 0));

  it("drops a read forwards that lands after going back to the newest, and asks for the newest page once (#266)", async () => {
    const { api, asked, answer } = heldHistory();
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    const landing = openAround(api, "r-garage", id(HIT));
    answer("around=");
    await landing;

    // Reading forwards, and Back to the newest pressed while that read is on the wire.
    const forwards = loadNewer(api, "r-garage");
    const back = leaveWindow(api, "r-garage");
    answer("around=");
    await forwards;
    await settle();

    // The late read answered a room that has since started over: it changes nothing,
    // and the newest page is still the thing on its way.
    const waiting = serverState(HOME).streams["r-garage"];
    expect(waiting?.messages).toEqual([]);
    expect(waiting?.loading).toBe(true);
    // So scrolling in the meantime can't ask for the newest page a second time.
    await loadOlder(api, "r-garage");
    const newestPage = "/rooms/r-garage/messages?limit=100";
    expect(asked.filter((path) => path === newestPage)).toHaveLength(1);

    answer("?limit=100");
    await back;
    const stream = serverState(HOME).streams["r-garage"];
    expect(stream?.atEnd).toBe(true);
    expect(stream?.loading).toBe(false);
    expect(stream?.messages.at(-1)?.id).toBe(id(NEWEST));
    expect(stream?.messages.some((held) => held.id === id(HIT))).toBe(false);
    expect(asked.filter((path) => path === newestPage)).toHaveLength(1);
  });

  it("leaves no gap when a search hit lands after going back to the newest", async () => {
    const { api, answer } = heldHistory();
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    // Back to the newest pressed while the window around the hit is still on its way.
    const landing = openAround(api, "r-garage", id(HIT));
    const back = leaveWindow(api, "r-garage");
    answer("around=");
    await landing;
    answer("?limit=100");
    await back;

    const stream = serverState(HOME).streams["r-garage"];
    const ids = (stream?.messages ?? []).map((held) => held.id);
    // The newest page, whole and attached, and nothing of the window beside it.
    expect(stream?.atEnd).toBe(true);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe(id(NEWEST - 99));
    expect(ids.at(-1)).toBe(id(NEWEST));
  });
});

/**
 * Letting go of history nobody is looking at (#173).
 *
 * What matters is what is never allowed to happen while doing it: a gap in
 * what is held, a duplicate, or a message that arrived during a page and got
 * lost between the two.
 */
describe("letting go of history", () => {
  /** A room with `newest` messages that can grow while a page is on the wire. */
  function growingRoom(start: number): {
    get: (path: string) => Message[];
    grow: () => Message;
    duringWindow: { run: (() => void) | null };
  } {
    let newest = start;
    const duringWindow: { run: (() => void) | null } = { run: null };
    const get = (path: string): Message[] => {
      const url = new URL(`https://x${path}`);
      const roomId = url.pathname.split("/")[2] ?? "r-garage";
      const inRoom = (list: Message[]) => list.map((one) => ({ ...one, room_id: roomId }));
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const around = url.searchParams.get("around");
      if (around !== null) {
        const at = Number(around.slice(1));
        // Answered as of now; anything posted during the round trip is not in it.
        const page = pageOf(Math.max(1, at - Math.ceil(limit / 2) + 1), Math.min(newest, at + Math.floor(limit / 2)));
        const run = duringWindow.run;
        duringWindow.run = null;
        run?.();
        return inRoom(page);
      }
      const before = url.searchParams.get("before");
      const top = before === null ? newest : Number(before.slice(1)) - 1;
      return inRoom(pageOf(Math.max(1, top - limit + 1), top));
    };
    const grow = (): Message => {
      newest += 1;
      return message(newest);
    };
    return { get, grow, duringWindow };
  }

  function held(roomId = "r-garage"): string[] {
    return (serverState(HOME).streams[roomId]?.messages ?? []).map((one) => one.id);
  }

  /** Consecutive ids, oldest first: no gap and no duplicate anywhere. */
  function expectContiguous(ids: string[]): void {
    const numbers = ids.map((one) => Number(one.slice(1)));
    for (let at = 1; at < numbers.length; at += 1) expect(numbers[at]).toBe((numbers[at - 1] ?? 0) + 1);
  }

  async function scrollBack(api: AuthedApi, pages: number): Promise<void> {
    for (let page = 0; page < pages; page += 1) await loadOlder(api, "r-garage");
  }

  beforeEach(async () => {
    await disconnect(HOME);
    invoked.length = 0;
  });

  it("keeps what is on screen plus a margin, and only past a threshold", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");
    await scrollBack(api, 6);
    // 700 held: under the threshold, so nothing is let go of.
    trimHistory(HOME, "r-garage", id(9_400), id(9_420));
    expect(held()).toHaveLength(700);

    await scrollBack(api, 4);
    expect(held()).toHaveLength(1_100);
    // Reading near the top of what is held: the newer end goes.
    trimHistory(HOME, "r-garage", id(8_950), id(8_980));
    const ids = held();
    expect(ids[0]).toBe(id(8_901));
    expect(ids[ids.length - 1]).toBe(id(9_280));
    expectContiguous(ids);
    const stream = serverState(HOME).streams["r-garage"];
    // No longer at the newest message: live messages wait on the server.
    expect(stream?.atEnd).toBe(false);
    expect(stream?.atStart).toBe(false);
  });

  it("reads back to the newest without a gap after letting the newer end go", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");
    await scrollBack(api, 10);
    trimHistory(HOME, "r-garage", id(8_950), id(8_980));

    // A live message while the room is behind: dropped, and remembered as newest.
    const fresh = room.grow();
    arrive(HOME, { s: 2, op: "message.create", d: fresh } as ServerFrame);
    expect(held()).not.toContain(fresh.id);

    for (let read = 0; read < 40 && serverState(HOME).streams["r-garage"]?.atEnd !== true; read += 1) {
      await loadNewer(api, "r-garage");
    }
    const ids = held();
    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(true);
    expect(ids[ids.length - 1]).toBe(fresh.id);
    expectContiguous(ids);
  });

  it("does not lose a message posted while the last page was on the wire", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    // Twenty messages short of the newest: one read forwards reaches the end,
    // and a message lands while that read is on the wire.
    await openAround(api, "r-garage", id(9_930));
    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(false);
    let fresh: Message | null = null;
    room.duringWindow.run = () => {
      fresh = room.grow();
      arrive(HOME, { s: 2, op: "message.create", d: fresh } as ServerFrame);
    };
    await loadNewer(api, "r-garage");
    const ids = held();
    expect(fresh).not.toBeNull();
    expect(ids[ids.length - 1]).toBe(id(10_001));
    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(true);
    expectContiguous(ids);
  });

  it("fetches the older end again without a gap after letting it go", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");
    await scrollBack(api, 10);
    // Back at the bottom: the older end goes, and the room stays live.
    trimHistory(HOME, "r-garage", id(9_980), id(10_000));
    expect(held()[0]).toBe(id(9_680));
    expect(serverState(HOME).streams["r-garage"]?.atEnd).toBe(true);

    await loadOlder(api, "r-garage");
    const ids = held();
    expect(ids[0]).toBe(id(9_580));
    expectContiguous(ids);
  });

  it("leaves a page in flight alone rather than trimming under it", async () => {
    let answer: (() => void) | null = null;
    let hold = false;
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, async (path: string) => {
      if (hold && path.includes("before=")) await new Promise<void>((done) => { answer = done; });
      return room.get(path);
    });
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");
    await scrollBack(api, 9);
    hold = true;
    const older = loadOlder(api, "r-garage");
    await vi.waitFor(() => expect(answer).not.toBeNull());
    trimHistory(HOME, "r-garage", id(9_980), id(10_000));
    expect(held()).toHaveLength(1_000);
    (answer as (() => void) | null)?.();
    await older;
    expect(held()).toHaveLength(1_100);
    expectContiguous(held());
  });

  it("keeps only the newest page of rooms you have left", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");
    await scrollBack(api, 4);
    await openAround(api, "r-den", id(5_000));
    await openRoom(api, "r-porch");

    releaseOtherRooms(HOME, "r-porch");
    const streams = serverState(HOME).streams;
    // The room you left keeps its newest page and stays live.
    expect(held("r-garage")).toHaveLength(100);
    expect(held("r-garage").at(-1)).toBe(id(10_000));
    expect(streams["r-garage"]?.atEnd).toBe(true);
    expectContiguous(held("r-garage"));
    // A window is dropped whole; walking back in opens the room fresh.
    expect(streams["r-den"]).toBeUndefined();
    // The room being opened is untouched.
    expect(held("r-porch")).toHaveLength(100);
  });

  it("drops an edit to a message that is not held instead of floating it above the rest", async () => {
    const room = growingRoom(10_000);
    const api = fakeApi(HOME, room.get);
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await openRoom(api, "r-garage");

    const old = { ...message(42), body: "edited", edited_at: 1 };
    arrive(HOME, { s: 2, op: "message.update", d: old } as ServerFrame);
    expect(held()).not.toContain(id(42));
    expectContiguous(held());
  });
});

/**
 * DMs in the store (SPEC §4.13, T-1302).
 *
 * The one thing that must never happen here is a DM ending up in `rooms`. The
 * wire keeps the two lists apart so that a surface drawing the server's rooms
 * cannot draw a private conversation by forgetting a filter, and this store
 * would hand that mistake straight back if it merged them.
 */
describe("DMs", () => {
  beforeEach(async () => {
    await Promise.all([disconnect(HOME), disconnect(WORK)]);
    invoked.length = 0;
  });

  it("keeps the two lists apart from the first frame", async () => {
    await connect(fakeApi(HOME));
    const matt = person("u-matt", "Matt");
    arrive(
      HOME,
      ready({
        user: matt,
        rooms: [room("r-garage", "garage", null)],
        dms: [dm("d1", ["u-matt", "u-callie"])],
      }),
    );

    const state = serverState(HOME);
    expect(state.rooms.map((r) => r.id)).toEqual(["r-garage"]);
    expect(state.dms.map((r) => r.id)).toEqual(["d1"]);
  });

  it("files a room.create by what the room says it is", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));

    arrive(HOME, { s: 2, op: "room.create", d: room("r-porch", "porch", null) } as ServerFrame);
    arrive(HOME, { s: 3, op: "room.create", d: dm("d1", ["u-matt", "u-callie"]) } as ServerFrame);

    const state = serverState(HOME);
    expect(state.rooms.map((r) => r.id)).toEqual(["r-porch"]);
    expect(state.dms.map((r) => r.id)).toEqual(["d1"]);
    expect(
      state.rooms.every((r) => r.kind === "room"),
      "a DM reached the room list",
    ).toBe(true);
  });

  it("updates a DM in place rather than adding it twice", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: person("u-matt", "Matt"), dms: [dm("d1", ["u-matt", "u-callie"])] }));

    // The same DM arriving again — which it does, because `POST /dms` answers
    // with it *and* the server publishes `room.create` to its members.
    arrive(HOME, {
      s: 2,
      op: "room.create",
      d: dm("d1", ["u-matt", "u-callie"], "m0001"),
    } as ServerFrame);

    const state = serverState(HOME);
    expect(state.dms).toHaveLength(1);
    expect(state.dms[0]?.last_message_id).toBe("m0001");
  });

  it("marks a server holding something new in a DM, and still not with a number", async () => {
    await connect(fakeApi(HOME));
    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, dms: [dm("d1", ["u-matt", "u-callie"], "m0007")] }));

    // Nothing read in it yet, so there is something new — the same boolean the
    // rooms use, reached by the same route (SPEC §4.2).
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(true);
  });

  it("doesn't mark a DM new for what you said yourself, from this device or another", async () => {
    await connect(fakeApi(HOME));
    const matt = person("u-matt", "Matt");
    arrive(HOME, ready({ user: matt, dms: [dm("d1", ["u-matt", "u-callie"])] }));
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(false);

    // Callie writes: something new.
    arrive(HOME, { s: 2, op: "message.create", d: { ...message(1), room_id: "d1", author_id: "u-callie" } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(true);

    // Matt answers from his computer, and this is his phone: answering is
    // catching up, so there's nothing new any more.
    arrive(HOME, { s: 3, op: "message.create", d: { ...message(2), room_id: "d1", author_id: "u-matt" } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(false);

    // And Callie again: new again.
    arrive(HOME, { s: 4, op: "message.create", d: { ...message(3), room_id: "d1", author_id: "u-callie" } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(true);
  });

  it("a person who is in no DMs has an empty list, not somebody else's", async () => {
    await connect(fakeApi(HOME));
    // `ready` carries the DMs *this person* is in, so a stranger's client has
    // nothing to draw. The server is what enforces it; this asserts the client
    // has no other source for the list.
    arrive(HOME, ready({ user: person("u-dave", "Dave"), rooms: [room("r-garage", "garage", null)] }));

    const state = serverState(HOME);
    expect(state.dms).toEqual([]);
    expect(state.rooms).toHaveLength(1);
  });
});

/**
 * Sending before the server answers (#128).
 *
 * A message shows the moment Enter is pressed, as a stand-in next to the room's
 * confirmed history, and is swapped for the real one when the server confirms
 * it. It is confirmed twice, by two routes: the answer to the send, and the
 * room's live announcement of the new message, which can arrive first.
 * Whichever lands first clears the stand-in. Getting that wrong shows a message
 * twice, or loses one, and only under real timing — so each order is driven
 * here by hand.
 */
describe("sending before the server answers", () => {
  /** One send's answer, held until the test lets it go. */
  interface Held {
    path: string;
    body: unknown;
    answer: (message: Message) => void;
    refuse: (error: Error) => void;
  }

  /** An API whose rooms open empty and whose sends wait to be answered. */
  function sendingApi(): { api: AuthedApi; held: Held[] } {
    const held: Held[] = [];
    const stub = {
      baseUrl: HOME,
      accessToken: async () => ({ token: "token", expiresAt: 0 }),
      get: async () => [],
      post: (path: string, body: unknown) =>
        new Promise<Message>((answer, refuse) => held.push({ path, body, answer, refuse })),
    };
    // The same confinement as `fakeApi`: the store touches only these members.
    return { api: stub as unknown as AuthedApi, held };
  }

  /** The server's copy of a send: a real id, and what was said. */
  function confirmed(at: number, body: string): Message {
    return { ...message(at), body };
  }

  /** What the room draws, top to bottom: confirmed history, then the sends still open. */
  function shown(): string[] {
    const stream = serverState(HOME).streams["r-garage"];
    return [...(stream?.messages ?? []), ...(stream?.pending.map((one) => one.message) ?? [])].map(
      (one) => one.body,
    );
  }

  function stillOpen(): number {
    return serverState(HOME).streams["r-garage"]?.pending.length ?? 0;
  }

  async function openGarage(): Promise<{ api: AuthedApi; held: Held[] }> {
    const sending = sendingApi();
    await connect(sending.api);
    arrive(HOME, ready({ user: person("u-matt", "Matt"), rooms: [room("r-garage", "garage", null)] }));
    await openRoom(sending.api, "r-garage");
    return sending;
  }

  beforeEach(async () => {
    await disconnect(HOME);
    invoked.length = 0;
  });

  it("shows a message the moment it is sent, before the server answers", async () => {
    const { api, held } = await openGarage();

    const sent = sendMessage(api, "r-garage", "hello");

    expect(shown()).toEqual(["hello"]);
    expect(serverState(HOME).streams["r-garage"]?.messages).toEqual([]);
    expect(serverState(HOME).streams["r-garage"]?.pending[0]?.message.author_id).toBe("u-matt");
    expect(held).toHaveLength(1);
    expect(held[0]?.path).toBe("/rooms/r-garage/messages");
    expect(held[0]?.body).toEqual({ body: "hello", reply_to: null, attachment_ids: null });

    held[0]?.answer(confirmed(1, "hello"));
    await sent;

    expect(shown()).toEqual(["hello"]);
    expect(stillOpen()).toBe(0);
    expect(serverState(HOME).streams["r-garage"]?.messages.map((one) => one.id)).toEqual([id(1)]);
  });

  it("shows two sends at once, in the order they were sent", async () => {
    const { api, held } = await openGarage();

    const first = sendMessage(api, "r-garage", "one");
    const second = sendMessage(api, "r-garage", "two");

    // Neither waits on the other: both are on the wire, and both show.
    expect(held).toHaveLength(2);
    expect(shown()).toEqual(["one", "two"]);

    held[0]?.answer(confirmed(1, "one"));
    held[1]?.answer(confirmed(2, "two"));
    await Promise.all([first, second]);

    expect(shown()).toEqual(["one", "two"]);
    expect(stillOpen()).toBe(0);
  });

  it("keeps both, in order and once each, when the second is answered first", async () => {
    const { api, held } = await openGarage();

    const first = sendMessage(api, "r-garage", "one");
    const second = sendMessage(api, "r-garage", "two");

    held[1]?.answer(confirmed(2, "two"));
    await second;
    // The second is confirmed and the first is still a stand-in: both show.
    expect(shown()).toEqual(["two", "one"]);
    expect(stillOpen()).toBe(1);

    held[0]?.answer(confirmed(1, "one"));
    await first;
    // Confirmed history is in the server's order, which is the order sent.
    expect(shown()).toEqual(["one", "two"]);
    expect(stillOpen()).toBe(0);

    // The live announcements come in afterwards, and change nothing.
    arrive(HOME, { s: 2, op: "message.create", d: confirmed(1, "one") } as ServerFrame);
    arrive(HOME, { s: 3, op: "message.create", d: confirmed(2, "two") } as ServerFrame);
    expect(shown()).toEqual(["one", "two"]);
  });

  it("shows one message when the live copy beats the answer to the send", async () => {
    const { api, held } = await openGarage();

    const sent = sendMessage(api, "r-garage", "hello");
    arrive(HOME, { s: 2, op: "message.create", d: confirmed(1, "hello") } as ServerFrame);

    // The announcement confirmed it: the stand-in has gone, the real one is there.
    expect(stillOpen()).toBe(0);
    expect(shown()).toEqual(["hello"]);

    held[0]?.answer(confirmed(1, "hello"));
    await sent;

    expect(shown()).toEqual(["hello"]);
    expect(serverState(HOME).streams["r-garage"]?.messages.map((one) => one.id)).toEqual([id(1)]);
  });

  it("keeps the same words sent twice as two messages", async () => {
    const { api, held } = await openGarage();

    const first = sendMessage(api, "r-garage", "same");
    const second = sendMessage(api, "r-garage", "same");
    expect(shown()).toEqual(["same", "same"]);

    // One announcement clears one stand-in, never both.
    arrive(HOME, { s: 2, op: "message.create", d: confirmed(1, "same") } as ServerFrame);
    expect(stillOpen()).toBe(1);
    expect(shown()).toEqual(["same", "same"]);

    held[0]?.answer(confirmed(1, "same"));
    await first;
    expect(shown()).toEqual(["same", "same"]);

    arrive(HOME, { s: 3, op: "message.create", d: confirmed(2, "same") } as ServerFrame);
    held[1]?.answer(confirmed(2, "same"));
    await second;

    expect(stillOpen()).toBe(0);
    expect(serverState(HOME).streams["r-garage"]?.messages.map((one) => one.id)).toEqual([id(1), id(2)]);
  });

  it("takes a refused send off the screen and throws", async () => {
    const { api, held } = await openGarage();

    const sent = sendMessage(api, "r-garage", "hello");
    expect(shown()).toEqual(["hello"]);

    held[0]?.refuse(new Error("refused"));
    // Thrown, not swallowed: the composer still has the words and can say so.
    await expect(sent).rejects.toThrow("refused");

    expect(shown()).toEqual([]);
  });
});

describe("report and block (PROTOCOL §5, T-1605)", () => {
  beforeEach(async () => {
    await disconnect(HOME);
  });

  const notFound = new ApiError(404, { code: "NOT_FOUND", message: "Not here.", retry_after_ms: null });

  it("a block made on another device holds here at once, and an unblock lifts it", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    arrive(HOME, { s: 2, op: "block.update", d: { user_id: "u-dex", blocked: true } } as ServerFrame);
    expect(serverState(HOME).blocked).toEqual(["u-dex"]);
    arrive(HOME, { s: 3, op: "block.update", d: { user_id: "u-dex", blocked: true } } as ServerFrame);
    expect(serverState(HOME).blocked).toEqual(["u-dex"]);
    arrive(HOME, { s: 4, op: "block.update", d: { user_id: "u-dex", blocked: false } } as ServerFrame);
    expect(serverState(HOME).blocked).toEqual([]);
  });

  it("what a blocked person says is nothing new, and a DM with only them never lights", async () => {
    await connect(fakeApi(HOME));
    // Dex's DM had something unread before the block.
    arrive(HOME, ready({ user: person("u-matt", "Matt"), rooms: [room("r-garage", "garage", null)], dms: [dm("d1", ["u-matt", "u-dex"], "m0005")] }));
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(true);
    arrive(HOME, { s: 2, op: "block.update", d: { user_id: "u-dex", blocked: true } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "d1")).toBe(false);

    // In a room, Dex saying something makes nothing new; Callie still does.
    arrive(HOME, { s: 3, op: "message.create", d: { ...message(10), author_id: "u-dex" } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(false);
    arrive(HOME, { s: 4, op: "message.create", d: { ...message(11), author_id: "u-callie" } } as ServerFrame);
    expect(hasNewActivity(serverState(HOME), "r-garage")).toBe(true);
  });

  it("loads who you've blocked, and a server from before blocks has nobody", async () => {
    let answer: () => unknown = () => ["u-dex"];
    const api = fakeApi(HOME, (path) => {
      expect(path).toBe("/me/blocks");
      return answer();
    });
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    await loadBlocks(api);
    expect(serverState(HOME).blocked).toEqual(["u-dex"]);

    answer = () => {
      throw notFound;
    };
    await loadBlocks(api);
    expect(serverState(HOME).blocked).toEqual([]);
  });

  it("a block shows at once, and one the server refuses is put back", async () => {
    const calls: string[] = [];
    let refuse = false;
    const api = {
      baseUrl: HOME,
      accessToken: async () => ({ token: "t", expiresAt: 0 }),
      put: async (path: string) => {
        calls.push(`PUT ${path}`);
        if (refuse) throw new Error("refused");
      },
      delete: async (path: string) => {
        calls.push(`DELETE ${path}`);
      },
    } as unknown as AuthedApi;
    await connect(api);
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));

    const blocking = setBlocked(api, "u-dex", true);
    expect(serverState(HOME).blocked).toEqual(["u-dex"]);
    await blocking;
    await setBlocked(api, "u-dex", false);
    expect(serverState(HOME).blocked).toEqual([]);
    expect(calls).toEqual(["PUT /me/blocks/u-dex", "DELETE /me/blocks/u-dex"]);

    refuse = true;
    await expect(setBlocked(api, "u-dex", true)).rejects.toThrow("refused");
    expect(serverState(HOME).blocked).toEqual([]);
  });

  it("the host's open reports load, and are asked for again when they change; nobody else's app asks", async () => {
    const asked: string[] = [];
    const host = { ...person("u-matt", "Matt"), is_host: true };
    const api = fakeApi(HOME, (path) => {
      asked.push(path);
      return [{ id: "r1", reporter_id: "u-callie", user_id: "u-dex", message: null, note: null, created_at: 1 }];
    });
    await connect(api);
    // The server's `ready` says you're the host, and that's what asks: the
    // app opening a server asks before the server has said who you are, and
    // that ask finds nobody and gives up.
    await loadReports(api);
    expect(asked).toEqual([]);
    arrive(HOME, ready({ user: host }));
    await vi.waitFor(() => expect(serverState(HOME).reports?.map((report) => report.id)).toEqual(["r1"]));
    expect(asked.filter((path) => path === "/reports")).toHaveLength(1);
    arrive(HOME, { s: 2, op: "reports.changed", d: {} } as ServerFrame);
    await vi.waitFor(() => expect(asked.filter((path) => path === "/reports")).toHaveLength(2));

    // Every connection's `ready` asks again: they may have changed meanwhile.
    await disconnect(HOME);
    asked.length = 0;
    await connect(api);
    arrive(HOME, ready({ user: host }));
    await vi.waitFor(() => expect(asked.filter((path) => path === "/reports")).toHaveLength(1));
    expect(serverState(HOME).reports?.map((report) => report.id)).toEqual(["r1"]);

    await disconnect(HOME);
    const member = fakeApi(HOME);
    await connect(member);
    arrive(HOME, ready({ user: person("u-callie", "Callie") }));
    // A member's app never asks: `fakeApi` without answers would throw.
    await loadReports(member);
    expect(serverState(HOME).reports).toBeNull();
  });

  it("a co-host's reports load too: when the host makes them one, and gone when they stop being one (#424)", async () => {
    const asked: string[] = [];
    const callie = person("u-callie", "Callie");
    const api = fakeApi(HOME, (path) => {
      asked.push(path);
      return [{ id: "r1", reporter_id: "u-dex", user_id: "u-sam", message: null, note: null, created_at: 1 }];
    });
    await disconnect(HOME);
    await connect(api);
    arrive(HOME, ready({ user: callie }));
    await loadReports(api);
    expect(asked).toEqual([]);

    // Made a co-host while connected: their app asks then, not at the next `ready`.
    arrive(HOME, { s: 2, op: "user.update", d: { ...callie, is_cohost: true } });
    await vi.waitFor(() => expect(serverState(HOME).reports?.map((report) => report.id)).toEqual(["r1"]));
    arrive(HOME, { s: 3, op: "reports.changed", d: {} } as ServerFrame);
    await vi.waitFor(() => expect(asked.filter((path) => path === "/reports")).toHaveLength(2));

    // Somebody else's change asks nothing.
    arrive(HOME, { s: 4, op: "user.update", d: { ...person("u-dex", "Dex"), is_cohost: true } });
    expect(asked.filter((path) => path === "/reports")).toHaveLength(2);

    // No longer one: the reports go with it.
    arrive(HOME, { s: 5, op: "user.update", d: callie });
    expect(serverState(HOME).reports).toBeNull();
    await disconnect(HOME);
  });
});

describe("a server's own emoji (#359)", () => {
  beforeEach(async () => {
    await disconnect(HOME);
  });

  const porch: CustomEmoji = { id: "e1", name: "porch_light", url: "/files/e1", animated: false, created_by: "u-matt", created_at: 1_790_000_000_000 };

  it("come with ready and are replaced whole by an update", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: person("u-matt", "Matt"), emoji: [] }));
    expect(serverState(HOME).emoji).toEqual([]);
    expect(serverState(HOME).ownEmoji).toBe(true);
    arrive(HOME, { s: 2, op: "emoji.update", d: { emoji: [porch] } });
    expect(serverState(HOME).emoji).toEqual([porch]);
  });

  it("a server from before them has none, and says it can't hold any", async () => {
    await connect(fakeApi(HOME));
    arrive(HOME, ready({ user: person("u-matt", "Matt") }));
    expect(serverState(HOME).emoji).toEqual([]);
    expect(serverState(HOME).ownEmoji).toBe(false);
  });
});
