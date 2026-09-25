// Two more servers for the multi-server version of the buddy list (?servers):
// friends back in Lisbon, and a game guild on raid night. Linger has no
// account that spans servers, so you are a separate person on each one: ids
// are prefixed with the server ("ash:kestrel"), and the same real friend on
// two servers would be two unlinked entries.

const at = (dayOffset, h, m) => new Date(2026, 8, 25 + dayOffset, h, m);

// Each server's own order is yours: this is the order you put them in.
export const servers = [
  { id: "good", name: "The Good Company", accent: "amber", me: "matt" },
  { id: "ash", name: "Ashen Lanterns", accent: "violet", me: "ash:lamplighter" },
  // The host set the server's time zone, so the list can say what time it is
  // there. It is the server's setting, not anybody's location.
  { id: "rib", name: "Casa da Ribeira", accent: "teal", me: "rib:matt", tz: { offsetHours: 6, place: "Lisbon" } },
];

export const srvOf = (id) => (id.includes(":") ? id.split(":")[0] : "good");

const P = (srv, id, name, color, rest) => ({ id: `${srv}:${id}`, name, color, font: "Geist Sans", weight: 600, ...rest });

export const extraPeople = [
  // --- Ashen Lanterns: raid night --------------------------------------
  P("ash", "lamplighter", "Lamplighter", "brass", { you: true, font: "Silkscreen", weight: 400, size: 0.86, presence: "around", room: null, status: "healing tonight. be nice" }),
  P("ash", "kestrel", "Kestrel", "sky", { font: "Space Grotesk", weight: 700, presence: "in_room", room: "ash:raid-night", voice: true, status: "raid lead. the pull timer is law" }),
  P("ash", "bramble", "Bramble", "fern", { font: "Newsreader", style: "italic", weight: 600, presence: "in_room", room: "ash:raid-night", voice: true, status: "tank. stand behind me" }),
  P("ash", "oxbow", "Oxbow", "rust", { font: "JetBrains Mono", weight: 500, presence: "in_room", room: "ash:raid-night", voice: true, status: "flasked, fed, emotionally ready" }),
  P("ash", "nyx", "Nyx", "violet", { gradient: ["violet", "indigo"], font: "Instrument Serif", style: "italic", weight: 400, size: 1.18, presence: "in_room", room: "ash:raid-night", voice: true, status: "on adds duty" }),
  P("ash", "grimwald", "Grimwald", "slate", { font: "IBM Plex Sans", weight: 700, presence: "in_room", room: "ash:raid-night", voice: true, status: "snacks secured" }),
  P("ash", "pip", "Pip", "lime", { font: "Commit Mono", weight: 700, presence: "in_room", room: "ash:raid-night", voice: true, status: "first raid!!" }),
  P("ash", "sable", "Sable", "rose", { font: "Inter", style: "italic", weight: 600, presence: "in_room", room: "ash:raid-night", voice: true, status: "one more try" }),
  P("ash", "morrow", "Morrow", "cyan", { font: "IBM Plex Sans", weight: 600, presence: "in_room", room: "ash:loot-council", status: "spreadsheet open" }),
  P("ash", "vesper", "Vesper", "orchid", { font: "Newsreader", style: "italic", weight: 500, presence: "around", status: "cooking, back for the next pull" }),
  P("ash", "halden", "Halden", "teal", { font: "Space Grotesk", weight: 500, presence: "around", status: "gathering herbs" }),
  P("ash", "tansy", "Tansy", "amber", { font: "Inter", weight: 700, presence: "away", away: "brb, dog needs out", since: "5m" }),
  P("ash", "quill", "Quill", "indigo", { presence: "offline", since: "2d" }),
  P("ash", "wren", "Wren", "mint", { font: "Newsreader", style: "italic", presence: "offline", since: "yesterday" }),
  P("ash", "ash", "Ash", "ember", { font: "JetBrains Mono", weight: 500, presence: "offline", since: "4d" }),
  P("ash", "juniper", "Juniper", "lime", { presence: "offline", away: "new job week, back soon", since: "3d" }),
  P("ash", "cobalt", "Cobalt", "azure", { font: "Space Grotesk", weight: 700, presence: "offline", since: "last week" }),

  // --- Casa da Ribeira: friends in Lisbon, where it's nearly five a.m. ----
  P("rib", "matt", "Matt", "azure", { you: true, presence: "around", room: null, status: "saudades de tudo" }),
  P("rib", "rui", "Rui", "brass", { font: "JetBrains Mono", weight: 500, presence: "around", status: "night shift ☕" }),
  P("rib", "ines", "Inês", "orchid", { font: "Instrument Serif", style: "italic", weight: 400, size: 1.18, presence: "away", away: "a dormir 😴", since: "4h" }),
  P("rib", "tiago", "Tiago", "sky", { font: "Space Grotesk", weight: 700, presence: "offline", since: "3h" }),
  P("rib", "marta", "Marta", "mint", { font: "Newsreader", style: "italic", weight: 600, presence: "offline", since: "5h" }),
  P("rib", "leonor", "Leonor", "rose", { font: "Inter", weight: 700, presence: "offline", away: "Porto till Monday", since: "6h" }),
];

export const extraRooms = [
  { id: "ash:raid-night", name: "raid-night", topic: "Fridays at nine. The pull timer is law." },
  { id: "ash:general", name: "general", topic: "Guild hall.", fresh: true },
  { id: "ash:loot-council", name: "loot-council", topic: "It's in the spreadsheet." },
  { id: "ash:lfg", name: "lfg", topic: "Looking for a group." },
  { id: "rib:geral", name: "geral", topic: "A casa é vossa.", fresh: true },
  { id: "rib:fotos", name: "fotos", topic: "The river, mostly.", fresh: true },
  { id: "rib:saudades", name: "saudades", topic: "For the ones who moved away." },
];

export const extraDms = [
  { id: "ash:dm-nyx", members: ["ash:lamplighter", "ash:nyx"] },
  { id: "rib:dm-ines", members: ["rib:matt", "rib:ines"] },
];

// The river at dusk from the other side, for Marta's photo.
const riverPhoto =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 50" shape-rendering="crispEdges">
<rect width="80" height="50" fill="#f2a65a"/><rect y="0" width="80" height="6" fill="#6f5a9c"/><rect y="6" width="80" height="5" fill="#a36a9a"/><rect y="11" width="80" height="5" fill="#e0857a"/><rect y="16" width="80" height="6" fill="#f2a65a"/>
<rect x="56" y="12" width="6" height="6" fill="#ffe2a0"/><rect x="55" y="13" width="8" height="4" fill="#ffe2a0"/>
<rect x="0" y="22" width="80" height="2" fill="#5a3b4a"/>
<rect x="6" y="14" width="2" height="9" fill="#b3372f"/><rect x="30" y="14" width="2" height="9" fill="#b3372f"/><rect x="0" y="20" width="44" height="1" fill="#b3372f"/>
<rect x="8" y="15" width="2" height="1" fill="#b3372f"/><rect x="10" y="16" width="3" height="1" fill="#b3372f"/><rect x="13" y="17" width="4" height="1" fill="#b3372f"/><rect x="17" y="18" width="5" height="1" fill="#b3372f"/><rect x="22" y="17" width="4" height="1" fill="#b3372f"/><rect x="26" y="16" width="2" height="1" fill="#b3372f"/><rect x="28" y="15" width="2" height="1" fill="#b3372f"/>
<rect x="0" y="24" width="80" height="14" fill="#3f6d8f"/><rect x="0" y="27" width="80" height="1" fill="#5b8fb0"/><rect x="10" y="30" width="22" height="1" fill="#f2a65a" opacity=".7"/><rect x="50" y="32" width="18" height="1" fill="#ffe2a0" opacity=".8"/><rect x="0" y="35" width="80" height="1" fill="#335a78"/>
<rect x="0" y="38" width="80" height="12" fill="#6b3a2e"/>
<rect x="2" y="34" width="12" height="6" fill="#d9774a"/><rect x="2" y="33" width="12" height="1" fill="#a24b2e"/><rect x="4" y="36" width="2" height="2" fill="#ffd98a"/><rect x="9" y="36" width="2" height="2" fill="#ffd98a"/>
<rect x="16" y="32" width="10" height="8" fill="#e8c9a0"/><rect x="16" y="31" width="10" height="1" fill="#a24b2e"/><rect x="18" y="34" width="2" height="2" fill="#ffd98a"/><rect x="22" y="34" width="2" height="2" fill="#6b4a3a"/>
<rect x="60" y="33" width="14" height="7" fill="#e6a860"/><rect x="60" y="32" width="14" height="1" fill="#a24b2e"/><rect x="63" y="35" width="2" height="2" fill="#ffd98a"/><rect x="68" y="35" width="2" height="2" fill="#6b4a3a"/>
<rect x="30" y="40" width="20" height="1" fill="#f2c14e"/><rect x="31" y="41" width="2" height="2" fill="#2b2b2b"/><rect x="47" y="41" width="2" height="2" fill="#2b2b2b"/><rect x="30" y="37" width="20" height="3" fill="#f2c14e"/><rect x="32" y="38" width="3" height="1" fill="#6b4a3a"/><rect x="37" y="38" width="3" height="1" fill="#6b4a3a"/><rect x="42" y="38" width="3" height="1" fill="#6b4a3a"/>
</svg>`);

let seq = 0;
const m = (author, time, text, extra = {}) => ({ id: `x${++seq}`, author, time, text, ...extra });

export const extraMessages = {
  "ash:raid-night": [
    m("ash:kestrel", at(0, 21, 2), "ok first pull at 9:10. everyone flasked?"),
    m("ash:oxbow", at(0, 21, 3), "flasked, fed, emotionally ready"),
    m("ash:grimwald", at(0, 21, 4), "snacks secured. I brought the good pretzels"),
    m("ash:pip", at(0, 21, 6), "what do I do if I die"),
    m("ash:nyx", at(0, 21, 6), "lie there with dignity"),
    m("ash:kestrel", at(0, 21, 41), "good tries everyone. we're close. 10 min break"),
    m("ash:sable", at(0, 21, 42), "stretching. hydrating. becoming a better person"),
    m("ash:kestrel", at(0, 22, 12), "Pip you're on adds this time"),
    m("ash:pip", at(0, 22, 12), "on it!!"),
    m("ash:bramble", at(0, 22, 31), "ok that wipe was on me. walked into the fire like a moth"),
    m("ash:lamplighter", at(0, 22, 32), "moths love a lamp. I've got you next time"),
    m("ash:sable", at(0, 22, 44), "one more try then we call it"),
    m("ash:kestrel", at(0, 22, 47), "pull in 2. water up, snacks down"),
  ],
  "ash:general": [
    m("ash:vesper", at(-1, 19, 5), "new guild tabard vote is up. choose wisely"),
    m("ash:nyx", at(0, 20, 40), "whoever keeps putting fish in the guild bank: I see you"),
    m("ash:halden", at(0, 22, 36), "it's me. it's art", { leftOffBefore: true }),
  ],
  "ash:loot-council": [
    m("ash:morrow", at(0, 22, 30), "rolls after the kill. it's in the spreadsheet, no whining"),
  ],
  "ash:lfg": [
    m("ash:halden", at(-1, 17, 20), "anyone up for a quick dungeon sunday afternoon?"),
    m("ash:wren", at(-1, 18, 2), "me, if it's before dinner"),
  ],
  "ash:dm-nyx": [
    m("ash:nyx", at(0, 22, 2), "can you keep me topped up on adds tonight 🙏"),
    m("ash:lamplighter", at(0, 22, 3), "always"),
  ],
  // Lisbon's afternoon is our morning; Rui's 4:40 a.m. is our 10:40 p.m.
  "rib:geral": [
    m("rib:ines", at(0, 9, 10), "Matt!! the pastelaria on our street closed 😭"),
    m("rib:tiago", at(0, 9, 14), "end of an era"),
    m("rib:ines", at(0, 9, 15), "the pastéis were never the same after you left anyway"),
    m("rib:marta", at(0, 10, 2), "sending you the river so you don't forget us", {
      leftOffBefore: true,
      image: { src: riverPhoto, alt: "The river at dusk: the red bridge, low houses and a yellow tram on the near bank", w: 400, h: 250 },
    }),
    m("rib:leonor", at(0, 10, 5), "ele não vai esquecer 🌊"),
    m("rib:rui", at(0, 22, 40), "can't sleep. anyone up? (nobody is up)"),
  ],
  "rib:fotos": [
    m("rib:marta", at(-1, 11, 30), "o rio hoje. the light was doing the thing again"),
    m("rib:tiago", at(0, 9, 26), "evidence: the new place's pastéis. not the same"),
  ],
  "rib:saudades": [
    m("rib:ines", at(-3, 14, 20), "remember the night the tram broke down and we walked home singing"),
    m("rib:matt", at(-3, 14, 41), "every time I hear a tram bell"),
  ],
  "rib:dm-ines": [
    m("rib:ines", at(-1, 13, 2), "call soon? I miss your terrible Portuguese"),
  ],
};
