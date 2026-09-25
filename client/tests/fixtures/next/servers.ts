/**
 * Two more servers for the buddy list with several servers, from the
 * prototype's `servers.js`: a game guild on raid night, and friends in
 * Lisbon. Linger has no account that spans servers, so you are a different
 * person on each one, and the same friend on two servers would be two
 * unlinked people.
 *
 * Each is one server's store state, like `evening()` for The Good Company.
 */
import type { PresenceEntry } from "../../../src/generated/PresenceEntry";
import type { Room } from "../../../src/generated/Room";
import type { Style } from "../../../src/generated/Style";
import type { User } from "../../../src/generated/User";
import type { GatewayState } from "../../../src/lib/gateway";
import { NOW } from "./evening";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const GUILD = "https://ashen-lanterns.example";
export const LISBON = "https://casa-da-ribeira.example";

/** Each server's name and the host's accent (a palette key). */
export const serverInfo = {
  [GUILD]: { name: "Ashen Lanterns", accent: "violet" },
  [LISBON]: { name: "Casa da Ribeira", accent: "teal" },
} as const;

function person(
  id: string,
  name: string,
  font_key: string,
  weight: Style["weight"],
  color: string,
  extra: { italic?: boolean; to?: string; line?: string | null; away?: string | null; seen?: number } = {},
): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: {
      font_key,
      weight,
      italic: extra.italic ?? false,
      fill: extra.to ? { kind: "gradient", from: color, to: extra.to } : { kind: "solid", color },
      effect: "none",
      msg_font_key: null,
    },
    status:
      extra.line !== undefined || extra.away !== undefined
        ? {
            line: extra.line ?? null,
            reading: null,
            listening: null,
            working_on: null,
            image_id: null,
            image_url: null,
            away_message: extra.away ?? null,
            away_since: extra.away ? NOW - HOUR : null,
          }
        : null,
    entrance_sound: null,
    last_seen_at: extra.seen ?? null,
  };
}

function room(id: string, name: string, position: number, topic: string): Room {
  return { id, slug: name, name, topic, kind: "room", member_ids: null, position, archived_at: null, last_message_id: null };
}

function dm(id: string, members: string[]): Room {
  return { id, slug: id, name: id, topic: null, kind: "dm", member_ids: members, position: 0, archived_at: null, last_message_id: null };
}

function at(user_id: string, state: PresenceEntry["state"], room_id: string | null = null): PresenceEntry {
  return { user_id, state, room_id, away_message: null };
}

// --- Ashen Lanterns: raid night --------------------------------------------

export const guildPeople = {
  lamplighter: person("a-lamplighter", "Lamplighter", "silkscreen", 400, "brass", { line: "healing tonight. be nice" }),
  kestrel: person("a-kestrel", "Kestrel", "space-grotesk", 700, "sky", { line: "raid lead. the pull timer is law" }),
  bramble: person("a-bramble", "Bramble", "newsreader", 700, "fern", { italic: true, line: "tank. stand behind me" }),
  oxbow: person("a-oxbow", "Oxbow", "jetbrains-mono", 500, "rust", { line: "flasked, fed, emotionally ready" }),
  nyx: person("a-nyx", "Nyx", "instrument-serif", 400, "violet", { italic: true, to: "indigo", line: "on adds duty" }),
  grimwald: person("a-grimwald", "Grimwald", "ibm-plex-sans", 700, "slate", { line: "snacks secured" }),
  pip: person("a-pip", "Pip", "commit-mono", 700, "lime", { line: "first raid!!" }),
  sable: person("a-sable", "Sable", "inter", 700, "rose", { italic: true, line: "one more try" }),
  morrow: person("a-morrow", "Morrow", "ibm-plex-sans", 500, "cyan", { line: "spreadsheet open" }),
  vesper: person("a-vesper", "Vesper", "newsreader", 500, "orchid", { italic: true, line: "cooking, back for the next pull" }),
  halden: person("a-halden", "Halden", "space-grotesk", 500, "teal", { line: "gathering herbs" }),
  tansy: person("a-tansy", "Tansy", "inter", 700, "amber", { away: "brb, dog needs out" }),
  quill: person("a-quill", "Quill", "geist-sans", 500, "indigo", { seen: NOW - 2 * DAY }),
  wren: person("a-wren", "Wren", "newsreader", 500, "mint", { italic: true, seen: NOW - DAY }),
} satisfies Record<string, User>;

const RAID = ["a-kestrel", "a-bramble", "a-oxbow", "a-nyx", "a-grimwald", "a-pip", "a-sable"];

/** Raid night: seven in voice in #raid-night, one short of full. */
export function guild(empty: GatewayState): GatewayState {
  return {
    ...empty,
    status: { kind: "ready", latency_ms: 31 },
    me: guildPeople.lamplighter,
    users: Object.values(guildPeople),
    rooms: [
      room("a-raid-night", "raid-night", 0, "Fridays at nine. The pull timer is law."),
      room("a-general", "general", 1, "Guild hall."),
      room("a-loot-council", "loot-council", 2, "It's in the spreadsheet."),
      room("a-lfg", "lfg", 3, "Looking for a group."),
    ],
    dms: [dm("a-dm-nyx", ["a-lamplighter", "a-nyx"])],
    presence: [
      at("a-lamplighter", "around"),
      ...RAID.map((id) => at(id, "in_room", "a-raid-night")),
      at("a-morrow", "in_room", "a-loot-council"),
      at("a-vesper", "around"),
      at("a-halden", "around"),
      { user_id: "a-tansy", state: "away", room_id: null, away_message: "brb, dog needs out" },
    ],
    occupancy: { "a-raid-night": RAID, "a-loot-council": ["a-morrow"] },
    voice: { "a-raid-night": RAID.map((user_id) => ({ session_id: `s-${user_id}`, user_id })) },
    // #general holds something new.
    newest: { "a-general": "m000903", "a-raid-night": "m000913", "a-dm-nyx": "m000920" },
    read: { "a-general": "m000901", "a-raid-night": "m000913", "a-dm-nyx": "m000920" },
    readLoaded: true,
  };
}

// --- Casa da Ribeira: friends in Lisbon, where it's nearly five a.m. -------

export const lisbonPeople = {
  matt: person("l-matt", "Matt", "geist-sans", 700, "azure", { line: "saudades de tudo" }),
  rui: person("l-rui", "Rui", "jetbrains-mono", 500, "brass", { line: "night shift ☕" }),
  ines: person("l-ines", "Inês", "instrument-serif", 400, "orchid", { italic: true, away: "a dormir 😴" }),
  tiago: person("l-tiago", "Tiago", "space-grotesk", 700, "sky", { seen: NOW - 3 * HOUR }),
  marta: person("l-marta", "Marta", "newsreader", 700, "mint", { italic: true, seen: NOW - 5 * HOUR }),
  leonor: person("l-leonor", "Leonor", "inter", 700, "rose", { away: "Porto till Monday", seen: NOW - 6 * HOUR }),
} satisfies Record<string, User>;

/** Nearly five in the morning there: Rui's up, Inês is asleep, the rest are gone. */
export function lisbon(empty: GatewayState): GatewayState {
  return {
    ...empty,
    status: { kind: "ready", latency_ms: 88 },
    me: lisbonPeople.matt,
    users: Object.values(lisbonPeople),
    rooms: [room("l-geral", "geral", 0, "A casa é vossa."), room("l-fotos", "fotos", 1, "The river, mostly."), room("l-saudades", "saudades", 2, "For the ones who moved away.")],
    dms: [dm("l-dm-ines", ["l-matt", "l-ines"])],
    presence: [at("l-matt", "around"), at("l-rui", "around"), { user_id: "l-ines", state: "away", room_id: null, away_message: "a dormir 😴" }],
    occupancy: {},
    voice: {},
    // #geral and #fotos hold something new.
    newest: { "l-geral": "m000806", "l-fotos": "m000808", "l-saudades": "m000810", "l-dm-ines": "m000811" },
    read: { "l-geral": "m000803", "l-fotos": "m000807", "l-saudades": "m000810", "l-dm-ines": "m000811" },
    readLoaded: true,
  };
}
