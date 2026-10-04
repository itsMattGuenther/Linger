import { describe, expect, it, vi } from "vitest";
import type { PresenceEntry } from "../../generated/PresenceEntry";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { GatewayState } from "../../lib/gateway";

// The store reaches for a notifier and a sound player at load; neither matters here.
vi.mock("../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("../../lib/gateway");
const { listModel } = await import("./list");
const { awayOn, foldedText, moveServer, moveShown, namesText, openText, seatsWords, serverHeader, serverNames } = await import("./servers");

const NOW = Date.parse("2026-09-25T22:52:00Z");

function person(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    is_cohost: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
    ...extra,
  };
}

function status(line: string | null, away: string | null = null): User["status"] {
  return { line, reading: null, listening: null, working_on: null, fields: [], image_id: null, image_url: null, away_message: away, away_since: null };
}

function room(id: string, name: string, position: number, extra: Partial<Room> = {}): Room {
  return { id, slug: name, name, topic: null, kind: "room", member_ids: null, position, archived_at: null, last_message_id: null, ...extra };
}

function at(user_id: string, state: PresenceEntry["state"], room_id: string | null = null): PresenceEntry {
  return { user_id, state, room_id, away_message: null };
}

const me = person("u-me", "Lamplighter", { status: status("healing tonight. be nice") });
const kestrel = person("u-kestrel", "Kestrel");
const bramble = person("u-bramble", "Bramble");
const oxbow = person("u-oxbow", "Oxbow");
const morrow = person("u-morrow", "Morrow");
const vesper = person("u-vesper", "Vesper");
const halden = person("u-halden", "Halden");
const tansy = person("u-tansy", "Tansy");
const quill = person("u-quill", "Quill");

/** A guild on raid night, as one server's store. */
function guild(extra: Partial<GatewayState> = {}): GatewayState {
  return {
    ...serverState("https://guild.example"),
    me,
    users: [me, kestrel, bramble, oxbow, morrow, vesper, halden, tansy, quill],
    rooms: [room("r-raid", "raid-night", 0), room("r-general", "general", 1), room("r-loot", "loot-council", 2)],
    presence: [
      at("u-me", "around"),
      at("u-kestrel", "in_room", "r-raid"),
      at("u-bramble", "in_room", "r-raid"),
      at("u-oxbow", "in_room", "r-raid"),
      at("u-morrow", "in_room", "r-loot"),
      at("u-vesper", "around"),
      at("u-halden", "idle"),
      at("u-tansy", "away"),
    ],
    occupancy: { "r-raid": ["u-kestrel", "u-bramble", "u-oxbow"], "r-loot": ["u-morrow"] },
    voice: {
      "r-raid": [
        { session_id: "s-k", user_id: "u-kestrel" },
        { session_id: "s-b", user_id: "u-bramble" },
        { session_id: "s-o", user_id: "u-oxbow" },
      ],
    },
    ...extra,
  };
}

/** You, changed: the store keeps you in the users list as well as in `me`. */
function asMe(changed: User): Partial<GatewayState> {
  return { me: changed, users: guild().users.map((user) => (user.id === changed.id ? changed : user)) };
}

function header(state: GatewayState, quiet = false) {
  return serverHeader(state, listModel(state, NOW), quiet);
}

describe("a server's header in the list", () => {
  it("lines up who's on: in voice, then in a room, then around, then away, never offline, never you", () => {
    const names = header(guild()).dots.map(({ user }) => user.display_name);
    expect(names.slice(0, 3).sort()).toEqual(["Bramble", "Kestrel", "Oxbow"]);
    expect(names[3]).toBe("Morrow");
    expect(new Set(names.slice(4, 6))).toEqual(new Set(["Vesper", "Halden"]));
    expect(names.at(-1)).toBe("Tansy");
    expect(names).not.toContain("Quill");
    expect(names).not.toContain("Lamplighter");
  });

  it("is bold when something inside is new, and never while the server is quiet", () => {
    const fresh = guild({ newest: { "r-general": "m9" }, read: { "r-general": "m1" }, readLoaded: true });
    expect(header(fresh).fresh).toBe(true);
    expect(header(fresh, true).fresh).toBe(false);
    expect(header(guild()).fresh).toBe(false);
    const dmFresh = guild({
      dms: [room("d-nyx", "d-nyx", 0, { kind: "dm", member_ids: ["u-me", "u-kestrel"] })],
      newest: { "d-nyx": "m5" },
      readLoaded: true,
    });
    expect(header(dmFresh).fresh).toBe(true);
  });

  it("is lit while a DM inside hasn't been read, even while the server is quiet (#291)", () => {
    const dmFresh = guild({
      dms: [room("d-nyx", "d-nyx", 0, { kind: "dm", member_ids: ["u-me", "u-kestrel"] })],
      newest: { "d-nyx": "m5" },
      readLoaded: true,
    });
    expect(header(dmFresh).lit).toBe(true);
    // A DM is for you, as a mention is: Quiet doesn't hide it.
    expect(header(dmFresh, true).lit).toBe(true);
    // Read, it goes out.
    expect(header({ ...dmFresh, read: { "d-nyx": "m5" } }).lit).toBe(false);
    // A room with something new is bold, never lit.
    const roomFresh = guild({ newest: { "r-general": "m9" }, read: { "r-general": "m1" }, readLoaded: true });
    expect(header(roomFresh).lit).toBe(false);
  });
});

describe("a folded server's one line", () => {
  it("names the room with voice on, and just the room once more than two are talking", () => {
    const line = header(guild()).folded;
    expect(line).toMatchObject({ kind: "voice", room: "raid-night", people: [] });
    expect(foldedText(line)).toBe("#raid-night in voice");
  });

  it("names up to two people talking", () => {
    const two = guild({ voice: { "r-raid": [{ session_id: "s-k", user_id: "u-kestrel" }, { session_id: "s-b", user_id: "u-bramble" }] } });
    expect(foldedText(header(two).folded)).toBe("Kestrel and Bramble in #raid-night");
    const one = guild({ voice: { "r-raid": [{ session_id: "s-k", user_id: "u-kestrel" }] } });
    expect(foldedText(header(one).folded)).toBe("Kestrel in #raid-night");
  });

  it("says a voice room is nearly full in words, counting you, and never before", () => {
    const seats = (ids: string[]) =>
      foldedText(header(guild({ voice: { "r-raid": ids.map((id, index) => ({ session_id: `s-${index}`, user_id: id })) } })).folded);
    // The room holds 60 (#197): 57 more besides the ones this guild has names for.
    const five = ["u-kestrel", "u-bramble", "u-oxbow", "u-morrow", "u-vesper"];
    const crowd = [...five, ...Array.from({ length: 52 }, (_, n) => `u-guest-${n}`)];
    expect(seats(five)).toBe("#raid-night in voice");
    expect(seats(crowd)).toBe("#raid-night in voice");
    expect(seats([...crowd, "u-halden"])).toBe("#raid-night in voice · room for two more");
    expect(seats([...crowd, "u-halden", "u-me"])).toBe("#raid-night in voice · room for one more");
    expect(seats([...crowd, "u-halden", "u-me", "u-tansy"])).toBe("#raid-night in voice · full");
  });

  it("isn't about voice when you're the only one in it", () => {
    const alone = guild({ voice: { "r-raid": [{ session_id: "s-me", user_id: "u-me" }] } });
    expect(header(alone).folded.kind).toBe("room");
  });

  it("without voice, names who's in the first room with somebody in it", () => {
    const line = header(guild({ voice: {} })).folded;
    // In the list's own order.
    expect(foldedText(line)).toBe("Bramble, Kestrel and others in #raid-night");
    const loot = guild({ voice: {}, occupancy: { "r-loot": ["u-morrow"] }, presence: [at("u-me", "around"), at("u-morrow", "in_room", "r-loot"), at("u-vesper", "around")] });
    expect(foldedText(header(loot).folded)).toBe("Morrow in #loot-council");
  });

  it("with nobody in a room, says it's quiet, and who's up", () => {
    const nobodyIn = { voice: {}, occupancy: {} };
    const aroundOnly = (ids: string[]) =>
      guild({ ...nobodyIn, presence: [at("u-me", "around"), ...ids.map((id) => at(id, "around")), at("u-tansy", "away")] });
    expect(foldedText(header(aroundOnly([])).folded)).toBe("quiet");
    expect(foldedText(header(aroundOnly(["u-vesper"])).folded)).toBe("quiet · Vesper's up");
    expect(foldedText(header(aroundOnly(["u-vesper", "u-halden"])).folded)).toBe("quiet · Halden and Vesper are up");
    expect(foldedText(header(aroundOnly(["u-vesper", "u-halden", "u-quill"])).folded)).toBe("quiet · Halden, Quill and others are up");
    // Idle is still up: at the computer, just not typing.
    const idle = guild({ ...nobodyIn, presence: [at("u-me", "around"), at("u-halden", "idle")] });
    expect(foldedText(header(idle).folded)).toBe("quiet · Halden's up");
  });

  it("never has a digit in it", () => {
    const states = [
      guild(),
      guild({ voice: {} }),
      guild({ voice: {}, occupancy: {} }),
      guild({ voice: { "r-raid": ["u-kestrel", "u-bramble", "u-oxbow", "u-morrow", "u-vesper", "u-halden", "u-me"].map((id, index) => ({ session_id: `s${index}`, user_id: id })) } }),
    ];
    for (const state of states) expect(foldedText(header(state).folded)).not.toMatch(/\d/);
  });
});

describe("an open server's line", () => {
  it("says who you are there, with your status, or your away message in quotes", () => {
    const open = header(guild()).open;
    expect(open && openText(open)).toBe("you're Lamplighter here · healing tonight. be nice");
    const away = guild(asMe({ ...me, status: status("healing tonight. be nice", "brb, dog needs out") }));
    const line = header(away).open;
    expect(line && openText(line)).toBe("you're Lamplighter here · “brb, dog needs out”");
    const bare = guild(asMe({ ...me, status: null }));
    const plain = header(bare).open;
    expect(plain && openText(plain)).toBe("you're Lamplighter here");
  });
});

describe("your servers", () => {
  it("knows where you're away", () => {
    const home = { id: "home", model: listModel(guild(), NOW) };
    const away = { id: "guild", model: listModel(guild(asMe({ ...me, status: status(null, "brb") })), NOW) };
    expect(awayOn([home, away])).toEqual(["guild"]);
    expect(awayOn([home])).toEqual([]);
  });

  it("move one place at a time, and not past either end", () => {
    const order = ["good", "ash", "rib"];
    expect(moveServer(order, "ash", -1)).toEqual(["ash", "good", "rib"]);
    expect(moveServer(order, "ash", 1)).toEqual(["good", "rib", "ash"]);
    // With one left out of what's shown, it keeps its place.
    expect(moveShown(["good", "ash", "rib"], ["good", "rib"], "rib", -1)).toEqual(["rib", "ash", "good"]);
    expect(moveShown(["good", "ash", "rib"], ["good", "rib"], "good", -1)).toEqual(["good", "ash", "rib"]);
    expect(moveShown(["good", "ash", "rib"], ["good", "rib"], "ash", 1)).toEqual(["good", "ash", "rib"]);
    expect(moveServer(order, "good", -1)).toEqual(order);
    expect(moveServer(order, "rib", 1)).toEqual(order);
    expect(moveServer(order, "nope", 1)).toEqual(order);
  });

  it("are named in a sentence, and nearly full voice rooms in words", () => {
    expect(serverNames(["A"])).toBe("A");
    expect(serverNames(["A", "B"])).toBe("A and B");
    expect(serverNames(["A", "B", "C"])).toBe("A, B and C");
    expect(namesText([kestrel], true)).toBe("Kestrel and others");
    expect([8, 57, 58, 59, 60, 61].map(seatsWords)).toEqual([null, null, "room for two more", "room for one more", "full", "full"]);
  });
});
