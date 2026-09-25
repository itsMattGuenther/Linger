/**
 * The prototype's Friday evening as real store state (GatewayState), for the
 * new client's fixture pages and tests. The same friends, rooms and moment as
 * `client/prototypes/buddy-list/`, so a screen can be compared with the
 * prototype it was built from.
 */
import type { PresenceEntry } from "../../../src/generated/PresenceEntry";
import type { Room } from "../../../src/generated/Room";
import type { Style } from "../../../src/generated/Style";
import type { User } from "../../../src/generated/User";
import type { UserStatus } from "../../../src/generated/UserStatus";
import type { GatewayState } from "../../../src/lib/gateway";

/** 22:52 on Friday 25 September 2026, the prototype's "now". */
export const NOW = Date.parse("2026-09-25T22:52:00");
const HOUR = 3_600_000;

export const SERVER = "https://good-company.example";
export const SERVER_NAME = "The Good Company";

function style(font_key: string, weight: Style["weight"], fill: Style["fill"], italic = false): Style {
  return { font_key, weight, italic, fill, effect: "none", msg_font_key: null };
}

function status(line: string | null, extra: Partial<UserStatus> = {}): UserStatus {
  return {
    line,
    reading: null,
    listening: null,
    working_on: null,
    image_id: null,
    image_url: null,
    away_message: null,
    away_since: null,
    ...extra,
  };
}

function person(id: string, name: string, personStyle: Style, extra: Partial<User> = {}): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: personStyle,
    status: null,
    entrance_sound: null,
    last_seen_at: null,
    ...extra,
  };
}

export const people = {
  matt: person("u-matt", "Matt", style("geist-sans", 700, { kind: "solid", color: "azure" }), {
    is_host: true,
    status: status("fixing the porch light (the real one)", { working_on: "a design for this app" }),
  }),
  eli: person("u-eli", "Eli", style("space-grotesk", 700, { kind: "solid", color: "amber" }), {
    status: status("second coffee, no regrets"),
  }),
  jules: person("u-jules", "Jules", style("instrument-serif", 400, { kind: "gradient", from: "fern", to: "teal" }, true), {
    status: status("speakers: finally set up", { listening: "Khruangbin — Con Todo El Mundo" }),
  }),
  dave: person("u-dave", "Dave", style("jetbrains-mono", 400, { kind: "solid", color: "cyan" }), {
    status: status("side two. nobody talk to me", { listening: "Bill Evans — Sunday at the Village Vanguard" }),
  }),
  callie: person("u-callie", "Callie", style("newsreader", 700, { kind: "gradient", from: "violet", to: "orchid" }, true), {
    status: status("on the couch with a book", { reading: "Piranesi" }),
  }),
  sam: person("u-sam", "Sam", style("silkscreen", 400, { kind: "solid", color: "rose" }), {
    status: status(null, { away_message: "back after work", away_since: NOW - HOUR }),
  }),
  jen: person("u-jen", "Jen", style("inter", 700, { kind: "solid", color: "lime" }), {
    status: status(null, { away_message: "camping till Sunday ⛺" }),
    last_seen_at: NOW - 26 * HOUR,
  }),
} satisfies Record<string, User>;

function room(id: string, name: string, position: number, topic: string, last: string | null): Room {
  return { id, slug: name, name, topic, kind: "room", member_ids: null, position, archived_at: null, last_message_id: last };
}

function dm(id: string, members: string[], last: string | null): Room {
  return { id, slug: id, name: id, topic: null, kind: "dm", member_ids: members, position: 0, archived_at: null, last_message_id: last };
}

export const rooms = {
  general: room("r-general", "general", 0, "Good company. No hurry.", "m000016"),
  listening: room("r-listening", "listening-room", 1, "Put something on.", "m000020"),
  plans: room("r-plans", "weekend-plans", 2, "Saturday walk, maybe.", "m000024"),
};

export const dms = {
  jules: dm("d-jules", ["u-matt", "u-jules"], "m000027"),
  eliSam: dm("d-eli-sam", ["u-matt", "u-eli", "u-sam"], "m000030"),
};

function presence(user_id: string, state: PresenceEntry["state"], room_id: string | null = null, away_message: string | null = null): PresenceEntry {
  return { user_id, state, room_id, away_message };
}

/** The whole evening as one server's store state. */
export function evening(empty: GatewayState): GatewayState {
  return {
    ...empty,
    status: { kind: "ready", latency_ms: 24 },
    me: people.matt,
    users: Object.values(people),
    rooms: Object.values(rooms),
    dms: Object.values(dms),
    presence: [
      presence("u-matt", "in_room", "r-general"),
      presence("u-eli", "in_room", "r-general"),
      presence("u-jules", "in_room", "r-general"),
      presence("u-dave", "in_room", "r-listening"),
      presence("u-callie", "around"),
      presence("u-sam", "away", null, "back after work"),
    ],
    occupancy: { "r-general": ["u-matt", "u-eli", "u-jules"], "r-listening": ["u-dave"] },
    voice: {
      "r-general": [
        { session_id: "s-eli", user_id: "u-eli" },
        { session_id: "s-jules", user_id: "u-jules" },
      ],
    },
    // #general and the Eli/Sam DM are read; #listening-room, #weekend-plans
    // and the Jules DM hold something new.
    newest: { "r-general": "m000016", "r-listening": "m000020", "r-plans": "m000024", "d-jules": "m000027", "d-eli-sam": "m000030" },
    read: { "r-general": "m000016", "r-listening": "m000019", "r-plans": "m000022", "d-eli-sam": "m000030" },
    readLoaded: true,
  };
}
