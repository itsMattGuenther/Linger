/**
 * The prototype's Friday evening as real store state (GatewayState), for the
 * new client's fixture pages and tests. The same friends, rooms and moment as
 * `client/prototypes/buddy-list/` (on the `design/buddy-list` branch), so a screen can be compared with the
 * prototype it was built from.
 */
import type { Attachment } from "../../../src/generated/Attachment";
import type { LinkPreview } from "../../../src/generated/LinkPreview";
import type { Message } from "../../../src/generated/Message";
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
        // Today's server shares everyone's microphone (VOICE-6); both are on.
        { session_id: "s-eli", user_id: "u-eli", controls: { muted: false, deafened: false } },
        { session_id: "s-jules", user_id: "u-jules", controls: { muted: false, deafened: false } },
      ],
    },
    // #general and the Eli/Sam DM are read; #listening-room, #weekend-plans
    // and the Jules DM hold something new.
    newest: { "r-general": "m000016", "r-listening": "m000020", "r-plans": "m000024", "d-jules": "m000027", "d-eli-sam": "m000030" },
    read: { "r-general": "m000016", "r-listening": "m000019", "r-plans": "m000022", "d-eli-sam": "m000030" },
    readLoaded: true,
  };
}

// ---------------------------------------------------------------------------
// The conversations: the prototype's thirty messages, as the server sends them.

/** A local time on the evening: `day` 0 is Friday the 25th, -1 the day before. */
function at(day: number, hour: number, minute: number): number {
  return new Date(2026, 8, 25 + day, hour, minute).getTime();
}

/** The prototype's photo of Jules's speakers, drawn small so it needs no file. */
export const SPEAKERS_PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 50" shape-rendering="crispEdges">
<rect width="80" height="50" fill="#2a2133"/>
<rect y="0" width="80" height="30" fill="#3a2d3f"/>
<rect x="52" y="4" width="20" height="14" fill="#ffcf7a" opacity=".9"/>
<rect x="52" y="10" width="20" height="1" fill="#3a2d3f"/><rect x="61" y="4" width="1" height="14" fill="#3a2d3f"/>
<rect x="0" y="30" width="80" height="3" fill="#7a4a2a"/><rect x="0" y="33" width="80" height="17" fill="#241a22"/>
<rect x="8" y="12" width="12" height="18" fill="#1c1c24"/><rect x="11" y="15" width="6" height="6" fill="#343444"/><rect x="13" y="17" width="2" height="2" fill="#555566"/><rect x="12" y="23" width="4" height="4" fill="#343444"/>
<rect x="36" y="12" width="12" height="18" fill="#1c1c24"/><rect x="39" y="15" width="6" height="6" fill="#343444"/><rect x="41" y="17" width="2" height="2" fill="#555566"/><rect x="40" y="23" width="4" height="4" fill="#343444"/>
<rect x="23" y="22" width="10" height="8" fill="#c8793a"/><rect x="24" y="23" width="8" height="6" fill="#d98c48"/><rect x="27" y="25" width="2" height="2" fill="#2a2133"/>
<rect x="26" y="14" width="2" height="8" fill="#6cc644"/><rect x="23" y="16" width="3" height="2" fill="#8bd450"/><rect x="28" y="15" width="3" height="2" fill="#8bd450"/><rect x="24" y="12" width="2" height="2" fill="#6cc644"/>
<rect x="60" y="24" width="12" height="6" fill="#e8792b"/><rect x="69" y="22" width="3" height="3" fill="#e8792b"/><rect x="62" y="26" width="4" height="3" fill="#fff3d6"/>
</svg>`);

/** The river trail link Jules shares, and the one-line card the server made of it. */
export const TRAIL_URL = "https://millrace-trail.org/river-loop";
export const previews: Record<string, LinkPreview> = {
  [TRAIL_URL]: { url: TRAIL_URL, domain: "millrace-trail.org", title: "Millrace River Trail — 4.2 mi loop", icon: null },
};

let serial = 0;
function said(room_id: string, author: User, created_at: number, body: string, extra: Partial<Message> = {}): Message {
  serial += 1;
  return {
    id: `m${String(serial).padStart(6, "0")}`,
    room_id,
    author_id: author.id,
    body,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at,
    ...extra,
  };
}

const photo = (created_at: number): Attachment => ({
  id: "a-speakers",
  filename: "speakers.png",
  mime: "image/png",
  size_bytes: 184_320,
  url: SPEAKERS_PHOTO,
  width: 400,
  height: 250,
  duration_ms: null,
  blurhash: null,
  poster_url: null,
  starred_at: null,
  uploader_id: "u-jules",
  created_at,
});

/** Every conversation's messages, oldest first, by room id. The ids match `evening`'s `newest`. */
export const messages: Record<string, Message[]> = {
  "r-general": [
    said("r-general", people.sam, at(-1, 23, 12), "ok who left the porch light on in the group photo"),
    said("r-general", people.callie, at(-1, 23, 14), "that's not the porch light, that's the moon"),
    said("r-general", people.sam, at(-1, 23, 15), "the lamp is the moon of the porch"),
    said("r-general", people.eli, at(-1, 23, 21), "going to bed on that note"),
    said("r-general", people.jules, at(0, 16, 2), "Anyone around for a little while? Finally got the speakers set up."),
    said("r-general", people.dave, at(0, 16, 5), "pics or it didn't happen"),
    said("r-general", people.jules, at(0, 16, 7), "exhibit a", { attachments: [photo(at(0, 16, 7))] }),
    said("r-general", people.eli, at(0, 16, 9), "Perfect timing. What are we listening to?", { reply_to: "m000005" }),
    said("r-general", people.eli, at(0, 22, 34), "A bit of Khruangbin. Feels like a good night to leave the windows open.", { reply_to: "m000005" }),
    said("r-general", people.matt, at(0, 22, 37), "This is exactly what I wanted this place to feel like. Somewhere to drop in, catch up, and stay a little longer."),
    said("r-general", people.eli, at(0, 22, 40), "No plans, no agenda. I can get behind that."),
    said("r-general", people.jules, at(0, 22, 43), "Also, Saturday walk? The trail by the river should be lovely this week."),
    said("r-general", people.jules, at(0, 22, 43), TRAIL_URL),
    said("r-general", people.matt, at(0, 22, 46), "Count me in. Let's put the details in #weekend-plans when we know."),
    said("r-general", people.eli, at(0, 22, 49), "Found the playlist from last summer, the one with the rain sounds 🌧️"),
    said("r-general", people.eli, at(0, 22, 49), "Putting it on now. Door's open if anyone wants to drop into voice."),
  ],
  "r-listening": [
    said("r-listening", people.dave, at(0, 21, 58), "Sunday at the Village Vanguard, side one. Nobody talk to me."),
    said("r-listening", people.callie, at(0, 22, 5), "respectfully talking to you: this is perfect"),
    said("r-listening", people.dave, at(0, 22, 30), "ok side two. someone else picks next"),
    said("r-listening", people.callie, at(0, 22, 44), "queue: Alice Coltrane, then whatever Jules wants"),
  ],
  "r-plans": [
    said("r-plans", people.sam, at(-1, 18, 20), "saturday walk, 9am? meet at the trailhead"),
    said("r-plans", people.jen, at(-1, 18, 31), "I'm camping till Sunday but take pictures of the ducks"),
    said("r-plans", people.callie, at(-1, 18, 40), "the ducks will be photographed"),
    said("r-plans", people.jules, at(0, 22, 45), "moving this here — river trail, 9 or 10?"),
  ],
  "d-jules": [
    said("d-jules", people.matt, at(-2, 19, 3), "thanks for the record recommendation, it's been on all week"),
    said("d-jules", people.jules, at(0, 22, 47), "did you ever fix the actual porch light"),
    said("d-jules", people.jules, at(0, 22, 47), "asking for the moths"),
  ],
  "d-eli-sam": [
    said("d-eli-sam", people.sam, at(-1, 12, 10), "surprise idea for Jules's birthday: we fix the porch light for real"),
    said("d-eli-sam", people.eli, at(-1, 12, 14), "I'll bring the ladder. Matt brings the bulb."),
    said("d-eli-sam", people.matt, at(-1, 12, 30), "deal"),
  ],
};

/** Where the prototype draws "you left off here": after this message, by room id. */
export const leftOff: Record<string, string> = {
  "r-plans": "m000023",
  "d-jules": "m000025",
};
