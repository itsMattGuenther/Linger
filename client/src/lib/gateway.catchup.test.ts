import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../generated/Message";
import type { Room } from "../generated/Room";
import type { ServerFrame } from "../generated/ServerFrame";
import type { User } from "../generated/User";
import type { AuthedApi } from "./api";
import { START, admit, advance, catchUp } from "./catchup";

// The same doubles as `gateway.test.ts`: a core that accepts every command,
// and event listeners the test can push frames through.
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (): Promise<boolean> => true,
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
vi.mock("./sound", () => ({ playKnock: () => false, playSound: () => false }));

const { apply, connect, disconnect, serverState, snapshotOf } = await import("./gateway");

const HOME = "https://home.example";

function fakeApi(baseUrl: string): AuthedApi {
  const stub = { baseUrl, accessToken: async () => ({ token: "token", expiresAt: 0 }) };
  return stub as unknown as AuthedApi;
}

function person(id: string, name: string, displayName = name): User {
  return {
    id,
    username: name,
    display_name: displayName,
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

function room(id: string, kind: "room" | "dm" = "room"): Room {
  return {
    id,
    slug: id,
    name: id,
    topic: null,
    kind,
    member_ids: kind === "dm" ? ["u-matt", "u-eli"] : null,
    position: 0,
    archived_at: null,
    last_message_id: null,
  };
}

function message(at: number, roomId: string): Message {
  return {
    id: `m${String(at).padStart(6, "0")}`,
    room_id: roomId,
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

/**
 * Two connections the way a real evening goes: a snapshot, people moving
 * about, messages in a room and a DM, a status change, then a re-identify
 * that starts over with a new room, and more of the same.
 */
function evening(): ServerFrame[] {
  const matt = person("u-matt", "matt");
  const eli = person("u-eli", "eli");
  const events = (session: string, rooms: Room[], at: number): ServerFrame[] => {
    // Unnumbered here; numbered in order below, after the `ready`.
    const body: ServerFrame[] = [
      { op: "presence.update", d: { user_id: "u-eli", state: "in_room", room_id: "r-general", away_message: null } },
      { op: "room.occupancy", d: { room_id: "r-general", user_ids: ["u-eli"] } },
      { op: "message.create", d: message(at, "r-general") },
      { op: "typing", d: { room_id: "r-general", user_id: "u-eli" } },
      { op: "user.update", d: person("u-eli", "eli", "Eli ☕") },
      { op: "message.create", d: message(at + 1, "d-eli") },
      { op: "presence.update", d: { user_id: "u-eli", state: "away", room_id: null, away_message: "back soon" } },
    ];
    return [
      { s: 1, op: "ready", d: { session_id: session, user: matt, users: [matt, eli], rooms, dms: [room("d-eli", "dm")], presence: [] } },
      ...body.map((frame, index): ServerFrame => ({ ...frame, s: index + 2 })),
    ];
  };
  return [
    ...events("session-a", [room("r-general")], 10),
    ...events("session-b", [room("r-general"), room("r-porch")], 20),
  ];
}

describe("a late window catching up through the real store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T22:52:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("ends with exactly the owner's state, whenever it starts listening and gets its answer", () => {
    const frames = evening();
    const empty = serverState("https://nobody.example");
    const fold = (upTo: number) => {
      let state = empty;
      let position = START;
      for (const frame of frames.slice(0, upTo)) {
        state = apply(state, frame);
        position = advance(position, frame);
      }
      return { state: { ...state, streams: {} }, position };
    };
    const final = fold(frames.length).state;

    for (let listenAt = 0; listenAt <= frames.length; listenAt += 1) {
      for (let answerAt = listenAt; answerAt <= frames.length; answerAt += 1) {
        for (const extra of [0, 1, 2]) {
          const bufferedTo = Math.min(answerAt + extra, frames.length);
          const snapshot = fold(answerAt);
          const { apply: pending, position } = catchUp(snapshot.position, frames.slice(listenAt, bufferedTo));
          let state = pending.reduce(apply, snapshot.state);
          let at = position;
          for (const frame of frames.slice(bufferedTo)) {
            if (!admit(at, frame)) continue;
            state = apply(state, frame);
            at = advance(at, frame);
          }
          expect({ ...state, streams: {} }, `listen ${listenAt} answer ${answerAt} extra ${extra}`).toEqual(final);
        }
      }
    }
  });
});

describe("the store's own position", () => {
  beforeEach(async () => {
    await disconnect(HOME);
    await connect(fakeApi(HOME));
  });

  it("tracks the session and last sequence number with every frame it applies", () => {
    const frames = evening();
    let expected = START;
    for (const frame of frames) {
      handlers.get("gateway:frame")?.({ payload: { server: HOME, frame } });
      expected = advance(expected, frame);
      const { state, position } = snapshotOf(HOME);
      expect(position).toEqual(expected);
      expect(state).toEqual({ ...serverState(HOME), streams: {} });
    }
    expect(snapshotOf(HOME).position).toEqual({ epoch: "session-b", seq: 8 });
  });

  it("starts over when the server is disconnected", async () => {
    for (const frame of evening().slice(0, 3)) {
      handlers.get("gateway:frame")?.({ payload: { server: HOME, frame } });
    }
    await disconnect(HOME);
    expect(snapshotOf(HOME).position).toEqual(START);
  });
});
