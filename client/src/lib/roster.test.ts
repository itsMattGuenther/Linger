import { describe, expect, it } from "vitest";

import type { PresenceEntry } from "../generated/PresenceEntry";
import type { Room } from "../generated/Room";
import type { User } from "../generated/User";
import type { UserStatus } from "../generated/UserStatus";
import { buildRoster, hasStatus, shortAgo, stateWord } from "./roster";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function person(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: {
      font_key: "geist-sans",
      weight: 500,
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

function status(fields: Partial<UserStatus> = {}): UserStatus {
  return {
    line: null,
    reading: null,
    listening: null,
    working_on: null,
    image_id: null,
    image_url: null,
    away_message: null,
    away_since: null,
    ...fields,
  };
}

function here(userId: string, extra: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    user_id: userId,
    state: "around",
    room_id: null,
    away_message: null,
    ...extra,
  };
}

const garage: Room = {
  id: "room-garage",
  slug: "garage",
  name: "Garage",
  topic: null,
  kind: "room",
  member_ids: null,
  position: 0,
  archived_at: null,
  last_message_id: null,
};

function roster(input: {
  users: User[];
  presence?: PresenceEntry[];
  rooms?: Room[];
  meId?: string | null;
  offlineAt?: Record<string, number>;
}) {
  return buildRoster({
    users: input.users,
    presence: input.presence ?? [],
    rooms: input.rooms ?? [garage],
    meId: input.meId ?? null,
    offlineAt: input.offlineAt ?? {},
    now: NOW,
  });
}

describe("buildRoster", () => {
  it("puts whoever is in a room first and the gone last, then sorts by name", () => {
    const users = [
      person("u-dave", "Dave"),
      person("u-jen", "Jen"),
      person("u-callie", "Callie"),
      person("u-abe", "Abe"),
    ];
    const presence = [
      here("u-dave", { state: "around" }),
      here("u-callie", { state: "in_room", room_id: garage.id }),
      here("u-abe", { state: "idle" }),
    ];
    expect(roster({ users, presence }).map((entry) => entry.user.display_name)).toEqual([
      "Callie", // in the room
      "Dave", // around
      "Abe", // idle
      "Jen", // no presence entry at all: offline
    ]);
  });

  it("sorts names without letting case decide the order", () => {
    const users = [person("u-1", "callie"), person("u-2", "Abe")];
    expect(roster({ users }).map((entry) => entry.user.display_name)).toEqual(["Abe", "callie"]);
  });

  it("resolves the room somebody is in", () => {
    const entries = roster({
      users: [person("u-1", "Callie")],
      presence: [here("u-1", { state: "in_room", room_id: garage.id })],
    });
    expect(entries[0]?.room?.slug).toBe("garage");
  });

  it("leaves the room null when the client does not hold it", () => {
    const entries = roster({
      users: [person("u-1", "Callie")],
      presence: [here("u-1", { state: "in_room", room_id: "room-unknown" })],
      rooms: [],
    });
    expect(entries[0]?.room).toBeNull();
    expect(entries[0]?.state).toBe("in_room");
  });

  it("shows no room for somebody who is offline", () => {
    const entries = roster({
      users: [person("u-1", "Dave")],
      presence: [here("u-1", { state: "offline", room_id: garage.id })],
    });
    expect(entries[0]?.room).toBeNull();
  });

  it("prefers what we watched over what the server last wrote down", () => {
    const users = [person("u-1", "Jen", { last_seen_at: NOW - DAY })];
    const entries = roster({ users, offlineAt: { "u-1": NOW - 2 * HOUR } });
    expect(entries[0]?.seenAt).toBe(NOW - 2 * HOUR);
    expect(shortAgo(entries[0]?.seenAt ?? 0, NOW)).toBe("2h");
  });

  it("falls back to last_seen_at for somebody who left before we arrived", () => {
    const users = [person("u-1", "Jen", { last_seen_at: NOW - 3 * DAY })];
    expect(roster({ users })[0]?.seenAt).toBe(NOW - 3 * DAY);
  });

  it("has no last-seen for an account the server has never seen", () => {
    expect(roster({ users: [person("u-1", "Jen")] })[0]?.seenAt).toBeNull();
  });

  it("takes the away message from presence over the one on the status", () => {
    const users = [person("u-1", "Jen", { status: status({ away_message: "stale" }) })];
    const entries = roster({
      users,
      presence: [here("u-1", { state: "away", away_message: "back after work" })],
    });
    expect(entries[0]?.awayMessage).toBe("back after work");
  });

  it("drops a left-over away message for somebody plainly here", () => {
    const users = [person("u-1", "Jen", { status: status({ away_message: "back after work" }) })];
    const entries = roster({
      users,
      presence: [here("u-1", { state: "in_room", room_id: garage.id })],
    });
    expect(entries[0]?.awayMessage).toBeNull();
  });

  it("keeps it for somebody who has gone quiet at the keyboard", () => {
    const users = [person("u-1", "Jen", { status: status({ away_message: "back after work" }) })];
    const entries = roster({ users, presence: [here("u-1", { state: "idle" })] });
    expect(entries[0]?.awayMessage).toBe("back after work");
  });

  it("keeps the status's away message for somebody who is offline", () => {
    const users = [person("u-1", "Jen", { status: status({ away_message: "back after work" }) })];
    expect(roster({ users })[0]?.awayMessage).toBe("back after work");
  });

  it("knows which card is yours", () => {
    const entries = roster({ users: [person("u-1", "Matt")], meId: "u-1" });
    expect(entries[0]?.isMe).toBe(true);
  });
});

describe("shortAgo", () => {
  it("says now for anything under a minute", () => {
    expect(shortAgo(NOW, NOW)).toBe("now");
    expect(shortAgo(NOW - 59_999, NOW)).toBe("now");
  });

  it("rounds down rather than ahead", () => {
    expect(shortAgo(NOW - MINUTE, NOW)).toBe("1m");
    expect(shortAgo(NOW - 40 * MINUTE, NOW)).toBe("40m");
    expect(shortAgo(NOW - (HOUR - 1), NOW)).toBe("59m");
    expect(shortAgo(NOW - HOUR, NOW)).toBe("1h");
    expect(shortAgo(NOW - (DAY - 1), NOW)).toBe("23h");
  });

  it("steps up through days, weeks and months", () => {
    expect(shortAgo(NOW - DAY, NOW)).toBe("1d");
    expect(shortAgo(NOW - 6 * DAY, NOW)).toBe("6d");
    expect(shortAgo(NOW - 7 * DAY, NOW)).toBe("1w");
    expect(shortAgo(NOW - 29 * DAY, NOW)).toBe("4w");
    expect(shortAgo(NOW - 30 * DAY, NOW)).toBe("1mo");
    expect(shortAgo(NOW - 400 * DAY, NOW)).toBe("13mo");
  });

  it("never counts a clock that is ahead of ours as the future", () => {
    expect(shortAgo(NOW + HOUR, NOW)).toBe("now");
  });
});

describe("the small pieces", () => {
  it("says every state out loud", () => {
    expect(stateWord("in_room")).toBe("in a room");
    expect(stateWord("around")).toBe("around");
    expect(stateWord("idle")).toBe("idle");
    expect(stateWord("away")).toBe("away");
    expect(stateWord("offline")).toBe("offline");
  });

  it("only opens a card that has something under it", () => {
    const [plain] = roster({ users: [person("u-1", "Jen")] });
    expect(plain && hasStatus(plain)).toBe(false);

    const [empty] = roster({ users: [person("u-1", "Jen", { status: status() })] });
    expect(empty && hasStatus(empty)).toBe(false);

    const [blank] = roster({ users: [person("u-1", "Jen", { status: status({ line: "" }) })] });
    expect(blank && hasStatus(blank)).toBe(false);

    const [lined] = roster({
      users: [person("u-1", "Jen", { status: status({ line: "at the shop" }) })],
    });
    expect(lined && hasStatus(lined)).toBe(true);

    const [field] = roster({
      users: [person("u-1", "Jen", { status: status({ listening: "Bill Evans" }) })],
    });
    expect(field && hasStatus(field)).toBe(true);

    const [away] = roster({
      users: [person("u-1", "Jen")],
      presence: [here("u-1", { state: "away", away_message: "back after work" })],
    });
    expect(away && hasStatus(away)).toBe(true);
  });
});
