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

import type { Message } from "../generated/Message";
import type { ReadyData } from "../generated/ReadyData";
import type { Room } from "../generated/Room";
import type { ServerFrame } from "../generated/ServerFrame";
import type { User } from "../generated/User";
import type { AuthedApi } from "./api";

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
  anyNewActivity,
  connect,
  disconnect,
  dismissKnock,
  hasNewActivity,
  KNOCK_TTL_MS,
  leaveWindow,
  loadNewer,
  loadOlder,
  openAround,
  openRoom,
  releaseOtherRooms,
  send,
  serverState,
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
    expect(anyNewActivity(serverState(HOME))).toBe(true);
    // An empty room is not "something new" on the other server.
    expect(anyNewActivity(serverState(WORK))).toBe(false);
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
    expect(anyNewActivity(serverState(HOME))).toBe(true);
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
