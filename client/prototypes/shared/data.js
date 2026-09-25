// One friend group, one evening: the server, people and conversation the
// prototypes draw, so a design is judged on the same content every time.
//
// "Now" is pinned to a Friday night so times, session labels and screenshots
// come out the same on every machine.

export const NOW = new Date(2026, 8, 25, 22, 52);

const at = (dayOffset, h, m) => new Date(2026, 8, 25 + dayOffset, h, m);

export const server = {
  name: "The Good Company",
  tagline: "A small place for friends to hang out.",
};

// Name styling is the AIM feature (SPEC §4.5): each person picks a face,
// weight, style and one palette color or a two-color gradient.
export const people = [
  {
    id: "matt",
    name: "Matt",
    you: true,
    color: "azure",
    font: "Geist Sans",
    weight: 600,
    presence: "in_room",
    room: "general",
    status: "fixing the porch light (the real one)",
    working: "a design for this app",
  },
  {
    id: "eli",
    name: "Eli",
    color: "amber",
    font: "Space Grotesk",
    weight: 700,
    presence: "in_room",
    room: "general",
    voice: true,
    status: "second coffee, no regrets",
  },
  {
    id: "jules",
    name: "Jules",
    color: "fern",
    gradient: ["fern", "teal"],
    font: "Instrument Serif",
    style: "italic",
    weight: 400,
    size: 1.18,
    presence: "in_room",
    room: "general",
    voice: true,
    status: "speakers: finally set up",
    listening: "Khruangbin — Con Todo El Mundo",
  },
  {
    id: "dave",
    name: "Dave",
    color: "cyan",
    font: "JetBrains Mono",
    weight: 500,
    presence: "in_room",
    room: "listening-room",
    status: "side two. nobody talk to me",
    listening: "Bill Evans — Sunday at the Village Vanguard",
  },
  {
    id: "callie",
    name: "Callie",
    color: "violet",
    gradient: ["violet", "orchid"],
    font: "Newsreader",
    style: "italic",
    weight: 600,
    presence: "around",
    status: "on the couch with a book",
    reading: "Piranesi",
  },
  {
    id: "sam",
    name: "Sam",
    color: "rose",
    font: "Silkscreen",
    weight: 400,
    size: 0.86,
    presence: "away",
    away: "back after work",
    since: "1h",
  },
  {
    id: "jen",
    name: "Jen",
    color: "lime",
    font: "Inter",
    weight: 700,
    presence: "offline",
    away: "camping till Sunday ⛺",
    since: "yesterday",
  },
];

export const byId = Object.fromEntries(people.map((p) => [p.id, p]));

export const rooms = [
  { id: "general", name: "general", topic: "Good company. No hurry." },
  { id: "listening-room", name: "listening-room", topic: "Put something on.", fresh: true },
  { id: "weekend-plans", name: "weekend-plans", topic: "Saturday walk, maybe.", fresh: true },
];

// A DM is a room with members and no name of its own (SPEC §4.13).
export const dms = [
  { id: "dm-jules", members: ["matt", "jules"], fresh: true },
  { id: "dm-eli-sam", members: ["matt", "eli", "sam"] },
];

// A tiny pixel-ish "photo" so the conversation has one image in it.
export const speakersPhoto =
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

let seq = 0;
const m = (author, time, text, extra = {}) => ({ id: `m${++seq}`, author, time, text, ...extra });

export const messages = {
  general: [
    m("sam", at(-1, 23, 12), "ok who left the porch light on in the group photo"),
    m("callie", at(-1, 23, 14), "that's not the porch light, that's the moon"),
    m("sam", at(-1, 23, 15), "the lamp is the moon of the porch"),
    m("eli", at(-1, 23, 21), "going to bed on that note"),
    m("jules", at(0, 16, 2), "Anyone around for a little while? Finally got the speakers set up."),
    m("dave", at(0, 16, 5), "pics or it didn't happen"),
    m("jules", at(0, 16, 7), "exhibit a", { image: { src: speakersPhoto, alt: "Two small speakers on a shelf, a plant between them, a cat asleep by the window", w: 400, h: 250 } }),
    m("eli", at(0, 16, 9), "Perfect timing. What are we listening to?", { replyTo: "m5" }),
    m("eli", at(0, 22, 34), "A bit of Khruangbin. Feels like a good night to leave the windows open.", { replyTo: "m5" }),
    m("matt", at(0, 22, 37), "This is exactly what I wanted this place to feel like. Somewhere to drop in, catch up, and stay a little longer."),
    m("eli", at(0, 22, 40), "No plans, no agenda. I can get behind that."),
    m("jules", at(0, 22, 43), "Also, Saturday walk? The trail by the river should be lovely this week."),
    m("jules", at(0, 22, 43), "", { link: { title: "Millrace River Trail — 4.2 mi loop", domain: "millrace-trail.org" } }),
    m("matt", at(0, 22, 46), "Count me in. Let's put the details in #weekend-plans when we know."),
    m("eli", at(0, 22, 49), "Found the playlist from last summer, the one with the rain sounds 🌧️"),
    m("eli", at(0, 22, 49), "Putting it on now. Door's open if anyone wants to drop into voice."),
  ],
  "listening-room": [
    m("dave", at(0, 21, 58), "Sunday at the Village Vanguard, side one. Nobody talk to me."),
    m("callie", at(0, 22, 5), "respectfully talking to you: this is perfect"),
    m("dave", at(0, 22, 30), "ok side two. someone else picks next"),
    m("callie", at(0, 22, 44), "queue: Alice Coltrane, then whatever Jules wants", { fresh: true }),
  ],
  "weekend-plans": [
    m("sam", at(-1, 18, 20), "saturday walk, 9am? meet at the trailhead"),
    m("jen", at(-1, 18, 31), "I'm camping till Sunday but take pictures of the ducks"),
    m("callie", at(-1, 18, 40), "the ducks will be photographed"),
    m("jules", at(0, 22, 45), "moving this here — river trail, 9 or 10?", { fresh: true, leftOffBefore: true }),
  ],
  "dm-jules": [
    m("matt", at(-2, 19, 3), "thanks for the record recommendation, it's been on all week"),
    m("jules", at(0, 22, 47), "did you ever fix the actual porch light", { fresh: true, leftOffBefore: true }),
    m("jules", at(0, 22, 47), "asking for the moths"),
  ],
  "dm-eli-sam": [
    m("sam", at(-1, 12, 10), "surprise idea for Jules's birthday: we fix the porch light for real"),
    m("eli", at(-1, 12, 14), "I'll bring the ladder. Matt brings the bulb."),
    m("matt", at(-1, 12, 30), "deal"),
  ],
};

// Things the group has shared, newest first (SPEC §4.4).
export const media = [
  { kind: "image", by: "jules", room: "general", time: at(0, 16, 7), title: "exhibit a", src: speakersPhoto, starred: true },
  { kind: "link", by: "jules", room: "general", time: at(0, 22, 43), title: "Millrace River Trail — 4.2 mi loop", domain: "millrace-trail.org" },
  { kind: "audio", by: "eli", room: "general", time: at(-60, 20, 15), title: "rain on the porch, last summer.m4a", size: "4.1 MB", starred: true },
  { kind: "link", by: "dave", room: "listening-room", time: at(-3, 21, 2), title: "Sunday at the Village Vanguard (1961)", domain: "bandcamp.com" },
  { kind: "file", by: "sam", room: "weekend-plans", time: at(-9, 10, 40), title: "trail-map.pdf", size: "812 KB" },
];

// ---------------------------------------------------------------------------
// Helpers the prototypes use.

export const color = (key) => `var(--name-${key})`;

export function nameStyle(p, { plain = false } = {}) {
  if (plain) return "";
  const parts = [
    `font-family:'${p.font}',var(--sans)`,
    `font-weight:${p.weight ?? 500}`,
    `font-style:${p.style ?? "normal"}`,
  ];
  if (p.size) parts.push(`font-size:${p.size}em`);
  if (p.gradient) {
    parts.push(
      `background:linear-gradient(92deg,${color(p.gradient[0])},${color(p.gradient[1])})`,
      "-webkit-background-clip:text",
      "background-clip:text",
      "color:transparent",
    );
  } else {
    parts.push(`color:${color(p.color)}`);
  }
  return parts.join(";");
}

export const nameHTML = (p, cls = "") =>
  `<span class="name ${cls}" data-person="${p.id}" style="${nameStyle(p)}">${esc(p.name)}</span>`;

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

export function fmtTime(d) {
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

// Natural-language session labels (SPEC §4.7), relative to NOW.
export function sessionLabel(d) {
  const days = Math.round((startOfDay(NOW) - startOfDay(d)) / 86400000);
  const h = d.getHours();
  const part = h < 5 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  if (days === 0) {
    if (part === "night") return "tonight";
    if (part === "late night") return "early this morning";
    return `this ${part}`;
  }
  if (days === 1) {
    if (part === "night") return "late last night";
    if (part === "late night") return "late last night";
    return `yesterday ${part}`;
  }
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  return part === "late night" ? `late ${day} night` : `${day} ${part}`;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Split a room's messages into sessions (3h gap) of groups (same author, 10m gap).
export function sessions(list) {
  const out = [];
  let session = null;
  let group = null;
  let prev = null;
  for (const msg of list) {
    const gap = prev ? (msg.time - prev.time) / 60000 : Infinity;
    if (gap > 180) {
      session = { label: sessionLabel(msg.time), time: msg.time, groups: [] };
      out.push(session);
      group = null;
    }
    if (!group || group.author !== msg.author || gap > 10 || msg.replyTo || msg.leftOffBefore) {
      group = { author: msg.author, time: msg.time, messages: [] };
      session.groups.push(group);
    }
    group.messages.push(msg);
    prev = msg;
  }
  return out;
}

export const findMessage = (id) => {
  for (const list of Object.values(messages)) {
    const hit = list.find((x) => x.id === id);
    if (hit) return hit;
  }
  return null;
};

export const dmTitle = (dm) =>
  dm.members
    .filter((id) => !byId[id].you)
    .map((id) => byId[id].name)
    .join(", ");

export const roomOf = (id) => rooms.find((r) => r.id === id) ?? dms.find((d) => d.id === id);

export const peopleIn = (roomId) => people.filter((p) => p.presence === "in_room" && p.room === roomId);

export const presenceWords = (p) => {
  if (p.presence === "in_room") return `in #${p.room}`;
  if (p.presence === "around") return "around";
  if (p.presence === "idle") return "idle";
  if (p.presence === "away") return `away · ${p.since}`;
  return `last here ${p.since}`;
};
