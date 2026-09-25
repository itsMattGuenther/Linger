import { describe, expect, it, vi } from "vitest";

import type { PresenceEntry } from "../../generated/PresenceEntry";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";

// The store module reaches for a notifier and a sound player at load; neither
// has anything to do with what the list shows.
vi.mock("../../notify/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("../../lib/gateway");
const { listModel } = await import("./list");

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
  status: { line: "speakers: finally set up", reading: null, listening: null, working_on: null, image_id: null, image_url: null, away_message: null, away_since: null },
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

  it("names DMs by the others in them and puts ones with something new first", () => {
    const { dms } = listModel(evening(), NOW);
    expect(dms.map((row) => row.label)).toEqual(["Jules", "Eli and Sam"]);
    expect(dms[0]?.fresh).toBe(true);
    expect(dms[1]?.people.map((user) => user.id)).toEqual(["u-eli", "u-sam"]);
  });

  it("puts you in your own card, not among the people", () => {
    const model = listModel(evening(), NOW);
    expect(model.me?.user.id).toBe("u-matt");
    expect(model.me?.where).toBe("in #general");
    const everyone = [...model.people.here, ...model.people.away, ...model.people.offline];
    expect(everyone.map((row) => row.user.id)).not.toContain("u-matt");
  });

  it("groups everyone else into here, away and offline, with where they are as a note", () => {
    const { people } = listModel(evening(), NOW);
    expect(people.here.map((row) => [row.user.display_name, row.note])).toEqual([
      ["Eli", "in #general"],
      ["Jules", "around"],
    ]);
    expect(people.away.map((row) => [row.user.display_name, row.note, row.line])).toEqual([
      ["Sam", "away", "back after work"],
    ]);
    expect(people.offline.map((row) => [row.user.display_name, row.note])).toEqual([["Jen", "last here 1d"]]);
  });

  it("uses the status line as the second line, and knows who is in voice", () => {
    const { people } = listModel(evening(), NOW);
    const [eliRow, julesRow] = people.here;
    expect(julesRow?.line).toBe("speakers: finally set up");
    expect(eliRow?.line).toBeNull();
    expect(eliRow?.inVoice).toBe(true);
    expect(julesRow?.inVoice).toBe(false);
  });

  it("says 'in a room' for somebody in a room this list can't see", () => {
    const state = { ...evening(), presence: [presence("u-eli", "in_room", "r-private")] };
    const eliRow = listModel(state, NOW).people.here.find((row) => row.user.id === "u-eli");
    expect(eliRow?.note).toBe("in a room");
  });

  it("is empty but well-formed before the server has said anything", () => {
    const model = listModel(serverState("https://nothing.example"), NOW);
    expect(model).toEqual({ me: null, rooms: [], dms: [], people: { here: [], away: [], offline: [] } });
  });
});
