/**
 * The presence driver's one job: when something changes, a frame goes out.
 *
 * `presence.test.ts` covers the deciding. This covers the part around it — the
 * guard that stops two passes running at once — because that guard had a bug
 * that no test of `decide` could ever have caught: the frames simply stopped,
 * quietly, and the last ones sent stayed true on the server.
 *
 * Since T-412 it also covers the other thing this file can get quietly wrong:
 * two servers sharing one window, where being in a room on one has to mean
 * being in no room on the other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientFrame } from "../generated/ClientFrame";

/** Everything sent, in order, tagged with the server it went to. */
const outbox: { server: string; frame: ClientFrame }[] = [];
let accept = true;

vi.mock("./gateway", () => ({
  send: async (server: string, frame: ClientFrame): Promise<boolean> => {
    if (accept) outbox.push({ server, frame });
    return accept;
  },
}));

const { dropPresence, setAway, setPresenceLive, setPresenceRoom, setPutAway, startPresence } = await import(
  "./watchPresence"
);

const HOME = "https://home.example";
const WORK = "https://work.example";
const ROOM = "room-garage";
const OTHER = "room-porch";

/** What went to one server, for the tests that only care about one. */
function sentTo(server: string): ClientFrame[] {
  return outbox.filter((line) => line.server === server).map((line) => line.frame);
}

/** A fresh driver: `startPresence` returns the stop function, which resets it. */
function reset(): void {
  const stop = startPresence();
  stop();
  startPresence();
  outbox.length = 0;
  accept = true;
}

/** The driver is async inside; let its sends settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("the presence driver", () => {
  beforeEach(() => {
    setPutAway(false);
    reset();
    setPresenceLive(HOME, false);
  });

  it("says nothing until the gateway is ready", async () => {
    setPresenceRoom(HOME, ROOM);
    await settle();
    expect(sentTo(HOME)).toEqual([]);
  });

  it("joins the room once it is", async () => {
    setPresenceLive(HOME, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    expect(sentTo(HOME)).toEqual([{ op: "room.focus", d: { room_id: ROOM } }]);
  });

  it("keeps working after a pass that had nothing to say", async () => {
    // The regression. A tick with no frame to send used to leave the in-flight
    // guard set forever, because the body finished before the promise it was
    // storing existed. Every later tick was swallowed and presence went silent
    // for the rest of the session — and the no-op tick is the common case: it
    // happens on the first pointer move after everything is in sync.
    setPresenceLive(HOME, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    outbox.length = 0;

    setPresenceRoom(HOME, ROOM); // no change: decide returns null, nothing is sent
    await settle();
    expect(sentTo(HOME)).toEqual([]);

    setAway(HOME, "back after work");
    await settle();
    expect(sentTo(HOME)).toEqual([
      { op: "room.focus", d: { room_id: null } },
      { op: "presence.update", d: { state: "away", away_message: "back after work" } },
    ]);
  });

  it("leaves the room before going away, in that order", async () => {
    setPresenceLive(HOME, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    outbox.length = 0;

    setAway(HOME, "brb");
    await settle();
    expect(sentTo(HOME).map((frame) => frame.op)).toEqual(["room.focus", "presence.update"]);
    expect(sentTo(HOME)[0]).toEqual({ op: "room.focus", d: { room_id: null } });
  });

  it("comes back, then rejoins the room", async () => {
    setPresenceLive(HOME, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    setAway(HOME, "brb");
    await settle();
    outbox.length = 0;

    setAway(HOME, null);
    await settle();
    expect(sentTo(HOME)).toEqual([
      { op: "presence.update", d: { state: "around", away_message: null } },
      { op: "room.focus", d: { room_id: ROOM } },
    ]);
  });

  it("does not say the same thing twice", async () => {
    setPresenceLive(HOME, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    setAway(HOME, "brb");
    await settle();
    outbox.length = 0;

    setAway(HOME, "brb");
    await settle();
    expect(sentTo(HOME)).toEqual([]);
  });

  it("says it again when the message is reworded", async () => {
    setPresenceLive(HOME, true);
    setAway(HOME, "brb");
    await settle();
    outbox.length = 0;

    setAway(HOME, "back at six");
    await settle();
    expect(sentTo(HOME)).toEqual([
      { op: "presence.update", d: { state: "away", away_message: "back at six" } },
    ]);
  });

  it("re-announces away after a reconnect, because the server forgot", async () => {
    setPresenceLive(HOME, true);
    setAway(HOME, "back at six");
    await settle();
    outbox.length = 0;

    // A fresh `ready` is a new session on the server: its presence map is
    // per-connection. A dropped socket is not somebody coming back to their desk.
    setPresenceLive(HOME, false);
    setPresenceLive(HOME, true);
    await settle();
    expect(sentTo(HOME)).toContainEqual({
      op: "presence.update",
      d: { state: "away", away_message: "back at six" },
    });
  });

  it("tries again after a send the gateway refused", async () => {
    setPresenceLive(HOME, true);
    accept = false;
    setPresenceRoom(HOME, ROOM);
    await settle();
    expect(sentTo(HOME)).toEqual([]);

    accept = true;
    setAway(HOME, "brb");
    await settle();
    // Still owes the leave, because the join never landed either.
    expect(sentTo(HOME).at(-1)).toEqual({
      op: "presence.update",
      d: { state: "away", away_message: "brb" },
    });
  });

  it("keeps each server's presence separate", async () => {
    setPresenceLive(HOME, true);
    setPresenceLive(WORK, true);
    setPresenceRoom(HOME, ROOM);
    await settle();

    expect(sentTo(HOME)).toEqual([{ op: "room.focus", d: { room_id: ROOM } }]);
    // Nothing was said to work at all: it has no room and is not away.
    expect(sentTo(WORK)).toEqual([]);
  });

  it("takes you out of the room on the server you switched away from", async () => {
    setPresenceLive(HOME, true);
    setPresenceLive(WORK, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    outbox.length = 0;

    // You clicked the other server in the rail, and landed in a room there.
    setPresenceRoom(WORK, OTHER);
    await settle();

    // You are only ever standing in one room. Home hears that you left before
    // work hears that you arrived is not required — that you left at all is.
    expect(sentTo(HOME)).toEqual([{ op: "room.focus", d: { room_id: null } }]);
    expect(sentTo(WORK)).toEqual([{ op: "room.focus", d: { room_id: OTHER } }]);
  });

  it("going away on one server says nothing on the other", async () => {
    setPresenceLive(HOME, true);
    setPresenceLive(WORK, true);
    await settle();
    outbox.length = 0;

    setAway(HOME, "back after work");
    await settle();
    expect(sentTo(HOME)).toEqual([
      {
        op: "presence.update",
        d: { state: "away", away_message: "back after work" },
      },
    ]);
    expect(sentTo(WORK)).toEqual([]);
  });

  // #830: the moment the phone app leaves the screen, every server hears it's
  // idle and in no room, so its notifications start; back, it's here again.
  it("tells every server a phone put away is idle at once, and here again when it's back", async () => {
    setPresenceLive(HOME, true);
    setPresenceLive(WORK, true);
    setPresenceRoom(HOME, ROOM);
    await settle();
    outbox.length = 0;

    setPutAway(true);
    await settle();
    expect(sentTo(HOME)).toEqual([
      { op: "room.focus", d: { room_id: null } },
      { op: "presence.update", d: { state: "idle", away_message: null } },
    ]);
    expect(sentTo(WORK)).toEqual([{ op: "presence.update", d: { state: "idle", away_message: null } }]);

    outbox.length = 0;
    setPutAway(false);
    await settle();
    // Moving into a room ends idle on the server (PROTOCOL §8), so that's all.
    expect(sentTo(HOME)).toEqual([{ op: "room.focus", d: { room_id: ROOM } }]);
    expect(sentTo(WORK)).toEqual([{ op: "presence.update", d: { state: "around", away_message: null } }]);
  });

  it("stops talking to a server that was signed out of", async () => {
    setPresenceLive(HOME, true);
    setPresenceLive(WORK, true);
    setPresenceRoom(WORK, OTHER);
    await settle();
    outbox.length = 0;

    dropPresence(WORK);
    setPresenceRoom(HOME, ROOM);
    await settle();

    expect(sentTo(HOME)).toEqual([{ op: "room.focus", d: { room_id: ROOM } }]);
    expect(sentTo(WORK)).toEqual([]);
  });
});
