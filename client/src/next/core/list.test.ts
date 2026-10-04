import { describe, expect, it, vi } from "vitest";

import type { PresenceEntry } from "../../generated/PresenceEntry";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";

// The store module reaches for a notifier and a sound player at load; neither
// has anything to do with what the list shows.
vi.mock("../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { apply, serverState } = await import("../../lib/gateway");
const { listModel, personRow, splitRooms } = await import("./list");
type RoomRow = import("./list").RoomRow;
type GatewayState = import("../../lib/gateway").GatewayState;

const NOW = Date.parse("2026-09-25T22:52:00Z");
const HOUR = 3_600_000;

function person(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    username: name.toLowerCase(),
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
    ...extra,
  };
}

function room(id: string, name: string, position: number, extra: Partial<Room> = {}): Room {
  return {
    id,
    slug: name,
    name,
    topic: null,
    kind: "room",
    member_ids: null,
    position,
    archived_at: null,
    last_message_id: null,
    ...extra,
  };
}

function presence(user_id: string, state: PresenceEntry["state"], room_id: string | null = null, away_message: string | null = null): PresenceEntry {
  return { user_id, state, room_id, away_message };
}

const matt = person("u-matt", "Matt");
const eli = person("u-eli", "Eli");
const jules = person("u-jules", "Jules", {
  status: { line: "speakers: finally set up", reading: null, listening: null, working_on: null, fields: [], image_id: null, image_url: null, away_message: null, away_since: null },
});
const sam = person("u-sam", "Sam");
const jen = person("u-jen", "Jen", { last_seen_at: NOW - 30 * HOUR });

function evening() {
  const empty = serverState("https://list.example");
  return {
    ...empty,
    me: matt,
    users: [matt, eli, jules, sam, jen],
    rooms: [
      room("r-plans", "weekend-plans", 2),
      room("r-general", "general", 0),
      room("r-old", "old-room", 1, { archived_at: NOW - 1000 * HOUR }),
      room("r-listening", "listening-room", 1),
    ],
    dms: [
      room("d-jules", "d-jules", 0, { kind: "dm", member_ids: ["u-matt", "u-jules"] }),
      room("d-eli-sam", "d-eli-sam", 0, { kind: "dm", member_ids: ["u-matt", "u-eli", "u-sam"] }),
    ],
    presence: [
      presence("u-matt", "in_room", "r-general"),
      presence("u-eli", "in_room", "r-general"),
      presence("u-jules", "around"),
      presence("u-sam", "away", null, "back after work"),
    ],
    occupancy: { "r-general": ["u-matt", "u-eli"] },
    voice: { "r-general": [{ session_id: "s-eli", user_id: "u-eli" }] },
    newest: { "r-plans": "m000009", "d-jules": "m000010" },
    read: { "r-plans": "m000005" },
  };
}

describe("the buddy list for one server", () => {
  it("lists live rooms by their position, never archived ones", () => {
    const { rooms } = listModel(evening(), NOW);
    expect(rooms.map((row) => row.name)).toEqual(["general", "listening-room", "weekend-plans"]);
  });

  it("marks a room with something unread as fresh, and only that", () => {
    const { rooms } = listModel(evening(), NOW);
    expect(rooms.filter((row) => row.fresh).map((row) => row.name)).toEqual(["weekend-plans"]);
  });

  it("shows who is in a room and whether voice is on there", () => {
    const general = listModel(evening(), NOW).rooms.find((row) => row.name === "general");
    expect(general?.people.map((user) => user.display_name)).toEqual(["Eli", "Matt"]);
    expect(general?.voice).toBe(true);
    const listening = listModel(evening(), NOW).rooms.find((row) => row.name === "listening-room");
    expect(listening?.people).toEqual([]);
    expect(listening?.voice).toBe(false);
  });

  it("puts a one-to-one DM on its person's row, lit while unread, and a group DM with the rooms (#351)", () => {
    const model = listModel(evening(), NOW);
    expect(model.groups.map((row) => row.label)).toEqual(["Eli and Sam"]);
    expect(model.groups[0]?.people.map(({ user, state }) => [user.id, state])).toEqual([
      ["u-eli", "in_room"],
      ["u-sam", "away"],
    ]);
    const julesRow = model.people.here.find((row) => row.user.id === "u-jules");
    expect(julesRow?.dm).toBe("d-jules");
    expect(julesRow?.fresh).toBe(true);
    const eliRow = model.people.here.find((row) => row.user.id === "u-eli");
    expect(eliRow?.dm).toBeNull();
    expect(eliRow?.fresh).toBe(false);
    // Every DM, for the picker's "the same people twice is the same DM".
    expect(model.dmMembers.map((dm) => dm.id)).toEqual(["d-jules", "d-eli-sam"]);
  });

  it("puts the people you're talking to first in each group: wrote to you, then talked lately, then everyone else (#351)", () => {
    const dave = person("u-dave", "Dave");
    const callie = person("u-callie", "Callie");
    const bo = person("u-bo", "Bo");
    const held: GatewayState = {
      ...evening(),
      users: [matt, eli, jules, sam, jen, dave, callie, bo],
      dms: [
        room("d-jules", "d-jules", 0, { kind: "dm", member_ids: ["u-matt", "u-jules"] }),
        room("d-dave", "d-dave", 0, { kind: "dm", member_ids: ["u-matt", "u-dave"] }),
        room("d-callie", "d-callie", 0, { kind: "dm", member_ids: ["u-matt", "u-callie"] }),
        room("d-jen", "d-jen", 0, { kind: "dm", member_ids: ["u-matt", "u-jen"], last_message_id: "m000003" }),
      ],
      presence: [...evening().presence, presence("u-dave", "in_room", "r-listening"), presence("u-callie", "around")],
      // Jules wrote and it's unread; Dave was talked with after Callie.
      newest: { "d-jules": "m000010", "d-dave": "m000020", "d-callie": "m000015" },
      read: { "d-dave": "m000020", "d-callie": "m000015" },
    };
    const names = (rows: { user: User }[]) => rows.map((row) => row.user.display_name);
    const { people } = listModel(held, NOW);
    // Unread first, even though Dave was talked with since; then newest
    // first; then everyone else in the roster's own order.
    expect(names(people.here)).toEqual(["Jules", "Dave", "Callie", "Eli"]);
    // Offline too: Jen is talked with, Bo isn't, though Bo comes first by name.
    expect(names(people.offline)).toEqual(["Jen", "Bo"]);

    // Callie writes: she's first. Reading it leaves her first, since she's
    // now the one talked with most recently (#248, the same rule as DMs).
    const said = apply(held, {
      s: 0,
      op: "message.create",
      d: { id: "m000030", room_id: "d-callie", author_id: "u-callie", body: "hi", reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: NOW },
    });
    expect(names(listModel(said, NOW).people.here)).toEqual(["Callie", "Jules", "Dave", "Eli"]);
    const read: GatewayState = { ...said, read: { ...said.read, "d-callie": "m000030", "d-jules": "m000010" } };
    expect(names(listModel(read, NOW).people.here)).toEqual(["Callie", "Dave", "Jules", "Eli"]);
  });

  it("keeps a DM with somebody the server no longer lists with the rooms, having no row to live on (#351)", () => {
    const held: GatewayState = {
      ...evening(),
      dms: [...evening().dms, room("d-gone", "d-gone", 0, { kind: "dm", member_ids: ["u-matt", "u-gone"] })],
    };
    const { groups, people } = listModel(held, NOW);
    expect(groups.map((row) => row.id).sort()).toEqual(["d-eli-sam", "d-gone"]);
    expect([...people.here, ...people.away, ...people.offline].map((row) => row.dm).filter(Boolean)).toEqual(["d-jules"]);
  });

  // `ready` says where each DM's conversation had got to when the app
  // connected, and never again; the order has to follow what arrives after.
  it("moves a group DM to the top when somebody writes in it, and keeps it there once read (#248)", () => {
    const labels = (held: GatewayState) => listModel(held, NOW).groups.map((row) => row.label);
    const said = (held: GatewayState, roomId: string, id: string, author: string) =>
      apply(held, {
        s: 0,
        op: "message.create",
        d: { id, room_id: roomId, author_id: author, body: "hi", reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: NOW },
      });
    const read = (held: GatewayState, roomId: string): GatewayState => ({ ...held, read: { ...held.read, [roomId]: held.newest[roomId] ?? "" } });
    const start: GatewayState = {
      ...evening(),
      dms: [
        room("d-jules-jen", "d-jules-jen", 0, { kind: "dm", member_ids: ["u-matt", "u-jules", "u-jen"], last_message_id: "m000010" }),
        room("d-eli-sam", "d-eli-sam", 0, { kind: "dm", member_ids: ["u-matt", "u-eli", "u-sam"], last_message_id: "m000004" }),
      ],
      newest: { "d-jules-jen": "m000010", "d-eli-sam": "m000004" },
      read: { "d-jules-jen": "m000010", "d-eli-sam": "m000004" },
    };
    expect(labels(start)).toEqual(["Jules and Jen", "Eli and Sam"]);

    const theirs = said(start, "d-eli-sam", "m000011", "u-sam");
    expect(labels(theirs)).toEqual(["Eli and Sam", "Jules and Jen"]);
    // Reading it used to send it back to where it was at connect.
    expect(labels(read(theirs, "d-eli-sam"))).toEqual(["Eli and Sam", "Jules and Jen"]);

    const mine = read(said(read(theirs, "d-eli-sam"), "d-jules-jen", "m000012", "u-matt"), "d-jules-jen");
    expect(labels(mine)).toEqual(["Jules and Jen", "Eli and Sam"]);
  });

  it("puts you in your own card, not among the people", () => {
    const model = listModel(evening(), NOW);
    expect(model.me?.user.id).toBe("u-matt");
    expect(model.me?.note).toBe("in #general");
    const everyone = [...model.people.here, ...model.people.away, ...model.people.offline];
    expect(everyone.map((row) => row.user.id)).not.toContain("u-matt");
  });

  it("gives your own card the row a friend's list has for you, and still keeps you out of People (#271)", () => {
    // What a friend's list says about you: their `me` is somebody else, you are one of their people.
    const theirs = listModel({ ...evening(), me: eli }, NOW).people.here.find((row) => row.user.id === "u-matt");
    expect(theirs?.note).toBe("in #general");
    expect(personRow(evening(), "u-matt", NOW)).toEqual(theirs);
    expect(personRow(evening(), "u-matt", NOW)).toEqual(listModel(evening(), NOW).me);

    // Away with a message: the same note and words friends see.
    const away = {
      ...evening(),
      presence: [presence("u-matt", "away", null, "walking the dog"), ...evening().presence.filter((entry) => entry.user_id !== "u-matt")],
    };
    expect(personRow(away, "u-matt", NOW)).toMatchObject({ state: "away", note: "away", line: "walking the dog" });
    const { people } = listModel(away, NOW);
    expect([...people.here, ...people.away, ...people.offline].map((row) => row.user.id)).not.toContain("u-matt");

    // Somebody the server doesn't list has no card.
    expect(personRow(evening(), "u-nobody", NOW)).toBeNull();
  });

  it("groups everyone else into here, away and offline, with where they are as a note", () => {
    const { people } = listModel(evening(), NOW);
    // Jules first: he has written to you and it's unread (#351).
    expect(people.here.map((row) => [row.user.display_name, row.note])).toEqual([
      ["Jules", "around"],
      ["Eli", "in #general"],
    ]);
    expect(people.away.map((row) => [row.user.display_name, row.note, row.line])).toEqual([
      ["Sam", "away", "back after work"],
    ]);
    expect(people.offline.map((row) => [row.user.display_name, row.note])).toEqual([["Jen", "last here 1d"]]);
  });

  it("uses the status line as the second line, and knows who is in voice", () => {
    const { people } = listModel(evening(), NOW);
    const julesRow = people.here.find((row) => row.user.id === "u-jules");
    const eliRow = people.here.find((row) => row.user.id === "u-eli");
    expect(julesRow?.line).toBe("speakers: finally set up");
    expect(eliRow?.line).toBeNull();
    expect(eliRow?.inVoice).toBe(true);
    expect(julesRow?.inVoice).toBe(false);
  });

  it("says 'around' for somebody in a DM, even one we're in, as an older server reports it (decision 21)", () => {
    for (const where of ["r-private", "d-jules"]) {
      // Out of voice: in a room's voice, they'd be in that room (#420).
      const state = { ...evening(), voice: {}, presence: [presence("u-eli", "in_room", where)] };
      const eliRow = listModel(state, NOW).people.here.find((row) => row.user.id === "u-eli");
      expect(eliRow?.note).toBe("around");
    }
  });

  describe("in a room's voice is in that room (#420)", () => {
    const names = (users: readonly User[]) => users.map((user) => user.display_name);
    const rowOf = (model: ReturnType<typeof listModel>, id: string) =>
      [...model.people.here, ...model.people.away, ...model.people.offline].find((row) => row.user.id === id);

    it("whatever has their attention: a game in front of them, Linger idle behind it", () => {
      for (const sent of ["idle", "around"] as const) {
        const model = listModel({ ...evening(), presence: [presence("u-eli", sent)], occupancy: {} }, NOW);
        expect(names(model.rooms.find((row) => row.name === "general")?.people ?? [])).toEqual(["Eli"]);
        const eliRow = rowOf(model, "u-eli");
        expect(eliRow?.state).toBe("in_room");
        expect(eliRow?.note).toBe("in #general");
        expect(model.people.here.map((row) => row.user.id)).toContain("u-eli");
      }
    });

    it("reading another room while they talk here, they're in both, and People names the one they're talking in", () => {
      const state = { ...evening(), presence: [presence("u-eli", "in_room", "r-listening")], occupancy: { "r-listening": ["u-eli"] } };
      const model = listModel(state, NOW);
      expect(names(model.rooms.find((row) => row.name === "general")?.people ?? [])).toEqual(["Eli"]);
      expect(names(model.rooms.find((row) => row.name === "listening-room")?.people ?? [])).toEqual(["Eli"]);
      expect(rowOf(model, "u-eli")?.note).toBe("in #general");
    });

    it("an away they chose still shows, and they're still in the room they're talking in", () => {
      const model = listModel({ ...evening(), presence: [presence("u-eli", "away", null, "making dinner")], occupancy: {} }, NOW);
      const eliRow = rowOf(model, "u-eli");
      expect(eliRow?.state).toBe("away");
      expect(eliRow?.note).toBe("away");
      expect(model.people.away.map((row) => row.user.id)).toEqual(["u-eli"]);
      expect(names(model.rooms.find((row) => row.name === "general")?.people ?? [])).toEqual(["Eli"]);
    });

    it("a DM's voice isn't a room anybody's shown in", () => {
      const state = { ...evening(), voice: { "d-jules": [{ session_id: "s-jules", user_id: "u-jules" }] }, presence: [presence("u-jules", "idle")] };
      const model = listModel(state, NOW);
      expect(rowOf(model, "u-jules")?.note).toBe("idle");
      expect(model.rooms.every((row) => !names(row.people).includes("Jules"))).toBe(true);
    });

    it("draws them in a group conversation's dots as in a room, too", () => {
      const state = { ...evening(), presence: [presence("u-eli", "idle"), presence("u-sam", "idle")] };
      const group = listModel(state, NOW).groups.find((row) => row.id === "d-eli-sam");
      expect(group?.people.map((member) => [member.user.id, member.state])).toEqual([
        ["u-eli", "in_room"],
        ["u-sam", "idle"],
      ]);
    });
  });

  it("is empty but well-formed before the server has said anything", () => {
    const model = listModel(serverState("https://nothing.example"), NOW);
    expect(model).toEqual({ me: null, rooms: [], groups: [], dmMembers: [], people: { here: [], away: [], offline: [] } });
  });
});

describe("a long room list", () => {
  const room = (id: string, busy: Partial<{ fresh: boolean; voice: boolean; people: number }> = {}): RoomRow => ({
    id,
    name: id,
    fresh: busy.fresh ?? false,
    voice: busy.voice ?? false,
    people: Array.from({ length: busy.people ?? 0 }, (_, n) => ({ id: `u${n}` }) as User),
  });

  it("shows every room up to eight", () => {
    const rooms = Array.from({ length: 8 }, (_, n) => room(`r${n}`));
    expect(splitRooms(rooms)).toEqual({ shown: rooms, more: [] });
  });

  it("past eight, folds the quiet ones, keeps anything going on, and keeps the host's order", () => {
    const rooms = Array.from({ length: 15 }, (_, n) =>
      room(`r${n}`, n === 12 ? { people: 2 } : n === 13 ? { fresh: true } : n === 14 ? { voice: true } : {}),
    );
    const { shown, more } = splitRooms(rooms);
    expect(shown.map((one) => one.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r12", "r13", "r14"]);
    expect(more.map((one) => one.id)).toEqual(["r5", "r6", "r7", "r8", "r9", "r10", "r11"]);
  });

  it("never hides a busy room, even past eight busy ones", () => {
    const rooms = Array.from({ length: 10 }, (_, n) => room(`r${n}`, { people: 1 }));
    expect(splitRooms(rooms).more).toEqual([]);
  });
});

