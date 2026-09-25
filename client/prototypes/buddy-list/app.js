// Buddy list: the main window is a tall list of your friends; every room and
// DM opens as its own small window. In the real app each of these would be an
// OS window (Tauri can open several), so a tiling desktop lays them out for
// you. Here they float on a drawn desktop, and "Tile" shows the tiled feel.

import {
  people, byId, rooms, dms, messages, media, server, NOW,
  nameHTML, color, fmtTime, sessions, sessionLabel, findMessage, dmTitle, esc,
} from "../shared/data.js";
import { createLife, still } from "../shared/life.js";
import { servers, srvOf, extraPeople, extraRooms, extraDms, extraMessages } from "./servers.js";
import { markHTML, MARK_KINDS } from "./marks.js";
import { createSettings } from "./settings.js";

// ?servers: the same list for somebody on three servers. Off by default, so
// the one-server version stays exactly as it was.
const params = new URLSearchParams(location.search);
const MULTI = params.has("servers");
// Linger's small mark beside the server name: ?mark=l|dots|lamp|word.
const MARK = MARK_KINDS.includes(params.get("mark")) ? params.get("mark") : "l";
// How conversations open: each in its own window (the default here, so the
// earlier screenshots stay true), or as tabs in one chat window (?tabs, or
// the setting behind the gear in the list's title bar).
let mode = params.has("tabs") ? "tabs" : "windows";
document.documentElement.classList.toggle("tabs-mode", mode === "tabs");
if (MULTI) {
  people.push(...extraPeople);
  for (const p of extraPeople) byId[p.id] = p;
  rooms.push(...extraRooms);
  dms.push(...extraDms);
  Object.assign(messages, extraMessages);
  document.documentElement.classList.add("multi");
}
const srvById = Object.fromEntries(servers.map((s) => [s.id, s]));
const order = servers.map((s) => s.id);
const folded = new Set(["ash", "rib"]);
const poppedOut = new Set();
// You are a different person on each server: this is who you are on the one
// a room, DM or person belongs to.
const meOf = (srvId) => byId[srvById[srvId].me];
const peopleOf = (s) => people.filter((p) => srvOf(p.id) === s);
const roomsOf = (s) => rooms.filter((r) => srvOf(r.id) === s);
const dmsOf = (s) => dms.filter((d) => srvOf(d.id) === s);
const rname = (id) => rooms.find((r) => r.id === id)?.name ?? id;

const life = createLife();
const me = people.find((p) => p.you);
document.getElementById(MULTI ? "pt-three" : "pt-one")?.setAttribute("aria-current", "page");
const desk = document.getElementById("desktop");
const toasts = document.getElementById("toasts");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- icons -----------------------------------------------------------------

const svg = (body, vb = "0 0 16 16") => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;

// A cog with eight square teeth, drawn as one outline so it matches the other
// line icons: unmistakably a gear, not a sun.
function cogPath(teeth = 8, rOut = 7.1, rIn = 5.2) {
  const step = (Math.PI * 2) / teeth;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    pts.push([a - step * 0.24, rIn], [a - step * 0.15, rOut], [a + step * 0.15, rOut], [a + step * 0.24, rIn]);
  }
  const P = ([a, r]) => `${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`;
  let d = `M${P(pts[0])}`;
  pts.forEach((_, i) => {
    const next = pts[(i + 1) % pts.length];
    d += i % 4 === 3 ? ` A${rIn} ${rIn} 0 0 1 ${P(next)}` : ` L${P(next)}`;
  });
  return `${d}Z`;
}
const I = {
  close: svg(`<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`),
  caret: svg(`<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  knock: svg(`<rect x="2.5" y="2" width="7" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="7.5" cy="8.4" r=".9" fill="currentColor"/><path d="M11.6 5.6c.8.7 1.2 1.5 1.2 2.4s-.4 1.7-1.2 2.4M13.4 4.2c1.2 1.1 1.8 2.4 1.8 3.8s-.6 2.7-1.8 3.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>`),
  message: svg(`<path d="M2.5 4.2c0-1 .8-1.7 1.7-1.7h7.6c1 0 1.7.8 1.7 1.7v5.1c0 1-.8 1.7-1.7 1.7H7.2L4.4 13.3v-2.3h-.2c-1 0-1.7-.8-1.7-1.7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`),
  speaker: svg(`<path d="M2.5 6h2.4L8.4 3v10L4.9 10H2.5z" fill="currentColor"/><path d="M10.6 5.6c.8.7 1.2 1.5 1.2 2.4s-.4 1.7-1.2 2.4M12.4 4c1.2 1.1 1.8 2.5 1.8 4s-.6 2.9-1.8 4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>`),
  note: svg(`<path d="M6 11.5V3.5l7-1.5v8" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="4.4" cy="11.6" r="1.8" fill="currentColor"/><circle cx="11.4" cy="10.1" r="1.8" fill="currentColor"/>`),
  book: svg(`<path d="M8 4.3C6.6 3.2 4.8 2.8 2.5 3v9.2c2.3-.2 4.1.2 5.5 1.3 1.4-1.1 3.2-1.5 5.5-1.3V3c-2.3-.2-4.1.2-5.5 1.3zM8 4.3v9.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>`),
  pencil: svg(`<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.1.6.6-3.1z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>`),
  moon: svg(`<path d="M12.8 10.2A5.5 5.5 0 0 1 5.8 3.2a5.5 5.5 0 1 0 7 7z" fill="currentColor"/>`),
  sun: svg(`<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`),
  door: svg(`<path d="M3 14V2.8c0-.4.3-.8.8-.8H10c.4 0 .8.3.8.8V14" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3 2.4l5 1.4V15L3 14" fill="currentColor" opacity=".35"/><circle cx="6.6" cy="8.6" r=".8" fill="currentColor"/><path d="M1.5 14h13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`),
  media: svg(`<rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="6.6" r="1.2" fill="currentColor"/><path d="M2.5 11.5l3.5-3 2.6 2.2 2-1.6 3 2.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>`),
  search: svg(`<circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.3 10.3l3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`),
  send: svg(`<path d="M2.5 8h9M8 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  mic: svg(`<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="currentColor"/><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
  micOff: svg(`<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="currentColor" opacity=".5"/><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
  link: svg(`<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
  audio: svg(`<path d="M2 8h1.6M4.8 5v6M7.4 3v10M10 5.5v5M12.6 7v2M14.2 8H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`),
  file: svg(`<path d="M4 1.8h5l3.2 3.2v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 1.8V5h3.2" fill="none" stroke="currentColor" stroke-width="1.4"/>`),
  star: svg(`<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/>`),
  quiet: svg(`<path d="M4.2 10.8V7.4a3.8 3.8 0 0 1 6.3-2.9M11.8 7.2v3.6l1.2 1.4H3.2M6.6 13.6a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`),
  popout: svg(`<path d="M9 2.5h4.5V7M13.3 2.7L7.5 8.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
  plus: svg(`<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`),
  more: svg(`<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>`),
  up: svg(`<path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  down: svg(`<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  check: svg(`<path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  gear: svg(`<path d="${cogPath()}" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.35"/>`),
  tag: svg(`<path d="M2.5 8.2V3.3c0-.5.4-.8.8-.8h4.9l5.3 5.3-5.7 5.7z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><circle cx="5.6" cy="5.6" r="1.1" fill="currentColor"/>`),
  windows: svg(`<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M1.8 5.6h12.4M6.4 5.6v7.9" stroke="currentColor" stroke-width="1.35"/>`),
  bell: svg(`<path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1.2 1.3H3z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M6.6 13.9a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round"/>`),
  key: svg(`<circle cx="5.4" cy="10.6" r="2.9" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M7.5 8.5l5.8-5.8M11.3 4.7l1.6 1.6M9.7 6.3l1.4 1.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`),
  stack: svg(`<path d="M8 2.2l6 3-6 3-6-3z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M2 8.2l6 3 6-3M2 11l6 3 6-3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>`),
  hash: svg(`<path d="M6.2 2.5L5 13.5M11 2.5L9.8 13.5M2.8 5.8h11M2.2 10.2h11" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`),
  people: svg(`<circle cx="5.6" cy="5.4" r="2.2" fill="none" stroke="currentColor" stroke-width="1.35"/><circle cx="11.2" cy="6.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M1.8 13.2c.4-2.2 2-3.5 3.8-3.5s3.4 1.3 3.8 3.5M10 9.7c1.9-.3 3.6.8 4.1 3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`),
  house: svg(`<path d="M2.5 7.3L8 2.8l5.5 4.5M4 6.2v7.3h8V6.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/><path d="M6.8 13.5v-3.3h2.4v3.3" fill="none" stroke="currentColor" stroke-width="1.35"/>`),
  play: svg(`<path d="M5 3.4v9.2l7.4-4.6z" fill="currentColor"/>`),
  compose: svg(`<path d="M13.5 8.6v3.9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.9" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M11.6 2.2l2.2 2.2-5.6 5.6-2.8.6.6-2.8z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>`),
  head: svg(`<path d="M2.8 10.5V8.3a5.2 5.2 0 0 1 10.4 0v2.2" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="2" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor"/><rect x="10.8" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor"/>`),
  headOff: svg(`<path d="M2.8 10.5V8.3a5.2 5.2 0 0 1 10.4 0v2.2" stroke="currentColor" stroke-width="1.4" fill="none" opacity=".55"/><rect x="2" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" opacity=".55"/><rect x="10.8" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" opacity=".55"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`),
  leave: svg(`<path d="M6.5 2.5H3.3a.8.8 0 0 0-.8.8v9.4c0 .4.4.8.8.8h3.2M10 5l3 3-3 3M13 8H6.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  go: svg(`<path d="M5.5 3.5h7v7M12.3 3.7L3.5 12.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
  intoTabs: svg(`<path d="M1.8 5.5h12.4M1.8 5.5V13a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V5.5M1.8 5.5V3a1 1 0 0 1 1-1h3.4a1 1 0 0 1 .9.6l.6 1.3" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linejoin="round"/><path d="M8 7.8v4M6.2 10.2L8 12l1.8-1.8" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
};

// --- voice belongs to a room -------------------------------------------------
//
// Other people are in voice where they are. You can be in voice in one room
// and reading another: your voice room is kept apart from the room you're
// looking at, so switching tabs or closing a window never leaves voice. Only
// Leave, joining voice somewhere else, or quitting does. One room at a time,
// across every server.
const voiceRoomOf = (p) =>
  p.you ? (p.voice ? p.voiceRoom ?? p.room : null) : p.voice && p.presence === "in_room" ? p.room : null;
const myVoice = () => people.find((p) => p.you && p.voice) ?? null;
const myVoiceRoom = () => {
  const p = myVoice();
  return p ? voiceRoomOf(p) : null;
};

function joinVoice(roomId) {
  // Moving voice keeps your mute and deafen choices; a fresh join starts clean.
  const before = myVoice();
  const keep = before ? { muted: !!before.muted, deafened: !!before.deafened, mutedBefore: before.mutedBefore } : { muted: false, deafened: false };
  if (before) {
    Object.assign(before, { voice: false, voiceRoom: null, muted: false, deafened: false });
    life.state.speaking.delete(before.id);
  }
  const my = meOf(srvOf(roomId));
  if (my === me) {
    if (me.presence !== "in_room" || me.room !== roomId) life.enter(roomId);
  } else {
    const from = my.presence;
    Object.assign(my, { presence: "in_room", room: roomId });
    onLife("presence", { person: my, from });
  }
  Object.assign(my, { voiceRoom: roomId }, keep);
  life.setVoice(my.id, true);
}

function leaveVoice() {
  const my = myVoice();
  if (!my) return;
  Object.assign(my, { voiceRoom: null, muted: false, deafened: false });
  life.setVoice(my.id, false);
}

function toggleMute() {
  const my = myVoice();
  if (!my) return;
  // Unmuting while deafened undeafens too: you can't talk to a room you can't hear.
  if (my.deafened) Object.assign(my, { deafened: false, muted: false });
  else my.muted = !my.muted;
  onLife("voice", { id: my.id, on: true });
}

function toggleDeafen() {
  const my = myVoice();
  if (!my) return;
  // Deafen mutes you too; undeafening gives your mic back the way it was.
  if (my.deafened) Object.assign(my, { deafened: false, muted: !!my.mutedBefore });
  else Object.assign(my, { deafened: true, mutedBefore: !!my.muted, muted: true });
  onLife("voice", { id: my.id, on: true });
}

// One marker per state, all the same size: here is a solid dot, away is a
// crescent moon, offline is the dot dimmed. Always in the person's color; the
// words live in labels and tooltips.
const MOON = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5.09 0.20A4.8 4.8 0 1 0 9.77 5.55A3.7 3.7 0 0 1 5.09 0.20Z" fill="currentColor"/></svg>`;
const dotHTML = (p, cls = "") =>
  `<span class="dot ${p.presence} ${cls}" style="--c:${color(p.color)}" aria-hidden="true">${p.presence === "away" ? MOON : ""}</span>`;

// The marker column every row shares, so names line up whether a row is one
// person or a group. A group's markers sit together inside the same slot.
function slotHTML(ps) {
  if (ps.length === 1) return `<span class="pm-slot" aria-hidden="true">${dotHTML(ps[0])}</span>`;
  const shown = ps.slice(0, 4);
  return `<span class="pm-slot" aria-hidden="true"><span class="pm-group n${shown.length}">${shown.map((p) => dotHTML(p, "g")).join("")}</span></span>`;
}

const voiceMark = (p) =>
  p.voice
    ? `<span class="vo" data-speak="${p.id}" style="--c:${color(p.color)}" title="in voice">${I.speaker}<span class="bars"><i></i><i></i><i></i></span></span>`
    : "";

const glyphFor = (p) =>
  p.listening ? [I.note, `listening to ${p.listening}`]
  : p.reading ? [I.book, `reading ${p.reading}`]
  : p.working ? [I.pencil, `working on ${p.working}`]
  : p.presence === "away" ? [I.moon, "away"]
  : null;

const roomName = (id) => {
  const r = rooms.find((x) => x.id === id);
  return r ? `#${r.name}` : `DM with ${dmTitle(dms.find((d) => d.id === id))}`;
};

// --- servers (only with ?servers) ------------------------------------------

// The time where a far-away server is, from the time zone its host set.
function timeThere(s) {
  if (!s.tz) return null;
  const t = new Date(life.now().getTime() + s.tz.offsetHours * 3600e3);
  const h = t.getHours();
  return { text: `${fmtTime(t)} there`, night: h < 7 || h >= 20 };
}

const srvStyle = (s) => `--acc:${color(s.accent)}`;
const srvTag = (id) => {
  if (!MULTI) return "";
  const s = srvById[srvOf(id)];
  const t = timeThere(s);
  return `<span class="srv-tag" style="${srvStyle(s)}" title="${esc(s.name)}${t ? ` · ${esc(t.text)}` : ""}"><i aria-hidden="true"></i><span class="st-t">${esc(s.name)}${t ? `<span class="tt">${t.night ? I.moon : I.sun}${esc(t.text)}</span>` : ""}</span></span>`;
};

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
// Voice holds eight a room. Say how many seats are left in words, and only
// when it's nearly full: a number here would be a counter.
const seatsWords = (n) => (n >= 8 ? "full" : n >= 6 ? `room for ${WORDS[8 - n]} more` : "");

const fresh = (s) => [...roomsOf(s.id), ...dmsOf(s.id)].some((x) => x.fresh);

function srvDots(s) {
  const ps = peopleOf(s.id).filter((p) => !p.you && p.presence !== "offline");
  const rank = (p) => (p.voice ? 0 : p.presence === "in_room" ? 1 : p.presence === "away" ? 3 : 2);
  return ps
    .sort((a, b) => rank(a) - rank(b))
    .map((p) => `<span class="dot xs ${p.presence}" style="--c:${color(p.color)}" title="${esc(p.name)}">${p.presence === "away" ? MOON : ""}</span>`)
    .join("");
}

const namesList = (ps) =>
  ps.length === 1 ? nameHTML(ps[0]) : `${ps.slice(0, -1).map((p) => nameHTML(p)).join(", ")} and ${nameHTML(ps.at(-1))}`;

// The line under a server's name: a fixed icon slot, so the words start under
// the name, then one line of text that ends in an ellipsis if it runs long.
const subLine = (icon, html) => `<span class="sub-ic" aria-hidden="true">${icon}</span><span class="sub-t">${html}</span>`;

// One line that says what a folded server is like right now.
function srvSummary(s) {
  const ps = peopleOf(s.id).filter((p) => !p.you);
  const parts = [];
  const t = timeThere(s);
  let icon = "";
  if (t) {
    icon = t.night ? I.moon : I.sun;
    parts.push(`<span class="there" title="The time in ${esc(s.tz.place)}, set by the host">${esc(t.text)}</span>`);
  }
  const voiceRoom = roomsOf(s.id).find((r) => ps.some((p) => voiceRoomOf(p) === r.id));
  if (voiceRoom) {
    const talking = ps.filter((p) => voiceRoomOf(p) === voiceRoom.id);
    const my = meOf(s.id);
    const seats = seatsWords(talking.length + (voiceRoomOf(my) === voiceRoom.id ? 1 : 0));
    const speaker = icon ? `<span class="talk-ic">${I.speaker}</span>` : "";
    icon ||= `<span class="talk-ic">${I.speaker}</span>`;
    parts.push(
      talking.length <= 2
        ? `<span class="talk">${speaker}${namesList(talking)} in <b>#${esc(voiceRoom.name)}</b></span>`
        : `<span class="talk">${speaker}<b>#${esc(voiceRoom.name)}</b> in voice</span>`,
    );
    if (seats) parts.push(seats);
  } else {
    const inRoom = ps.filter((p) => p.presence === "in_room");
    const around = ps.filter((p) => p.presence === "around" || p.presence === "idle");
    if (inRoom.length) parts.push(`${namesList(inRoom.slice(0, 2))} in <b>#${esc(rname(inRoom[0].room))}</b>`);
    else if (around.length === 1) parts.push(`quiet · ${nameHTML(around[0])}’s up`);
    else if (around.length) parts.push(`quiet · ${namesList(around.slice(0, 2))} are up`);
    else parts.push("quiet");
  }
  return subLine(icon, parts.join('<span class="sep">·</span>'));
}

// Who you are on this server, and your status there. The status is the part
// that gives way, with an ellipsis, when the line is short.
function srvYou(s) {
  const my = meOf(s.id);
  const st = my.presence === "away" ? `<span class="st away">“${esc(my.away)}”</span>` : my.status ? `<span class="st">${esc(my.status)}</span>` : "";
  return `<button class="srv-you" data-edit-status="${s.id}" data-key="you-${s.id}" aria-label="You're ${esc(my.name)} on ${esc(s.name)}. Your status there: ${esc(my.status ?? "")}. Edit it"><span class="you-is">you're ${nameHTML(my)} here</span>${st ? `<span class="sep">·</span>${st}` : ""}</button>`;
}

// An open server's line: the time there, if the host set one, then you.
function srvOpenLine(s) {
  const t = timeThere(s);
  return `<span class="sub-ic" aria-hidden="true">${t ? (t.night ? I.moon : I.sun) : ""}</span>${t ? `<span class="there" title="The time in ${esc(s.tz.place)}, set by the host">${esc(t.text)}</span><span class="sep">·</span>` : ""}${srvYou(s)}`;
}

function serverHTML(s) {
  const isFolded = folded.has(s.id);
  const popped = poppedOut.has(s.id);
  const bold = fresh(s) && !s.quiet;
  const head = `
    <div class="srv-h">
      <button class="srv-toggle" data-srv-toggle="${s.id}" data-key="srv-${s.id}" ${popped ? "" : `aria-expanded="${!isFolded}"`} aria-label="${esc(s.name)}${bold ? ", something new" : ""}${s.quiet ? ", quiet" : ""}${popped ? ", in its own window" : ""}">
        ${popped ? I.popout.replace("<svg", '<svg class="caret popped"') : I.caret.replace("<svg", '<svg class="caret"')}
        <span class="srv-mark" aria-hidden="true"></span>
        <span class="srv-name ${bold ? "fresh" : ""}">${esc(s.name)}</span>
        ${s.quiet ? `<span class="srv-quiet" title="Quiet: no chimes, no bold, no arrival cards">${I.quiet}</span>` : ""}
        <span class="srv-dots" aria-hidden="true">${srvDots(s)}</span>
      </button>
      <button class="srv-menu-btn" data-srv-menu="${s.id}" data-key="menu-${s.id}" aria-haspopup="menu" aria-label="${esc(s.name)} options">${I.more}</button>
    </div>`;
  if (popped) {
    const t = timeThere(s);
    return `<section class="srv popped" data-srv="${s.id}" style="${srvStyle(s)}">${head}<div class="srv-sub">${subLine(t ? (t.night ? I.moon : I.sun) : "", `${t ? `${esc(t.text)}<span class="sep">·</span>` : ""}in its own window`)}</div></section>`;
  }
  return `<section class="srv ${isFolded ? "folded" : ""} ${s.quiet ? "quiet" : ""}" data-srv="${s.id}" style="${srvStyle(s)}">
    ${head}
    <div class="srv-sub ${isFolded ? "" : "open"}">${isFolded ? srvSummary(s) : srvOpenLine(s)}</div>
    ${isFolded ? "" : `<div class="srv-body">${sectionHTML(s.id)}</div>`}
  </section>`;
}

function serversHTML() {
  return (
    order.map((id) => serverHTML(srvById[id])).join("") +
    `<button class="add-srv" data-add-server data-key="add-server">${I.plus}<span>Add a server</span></button>`
  );
}

// The server menu: quiet it, give it its own window, move it.
let menuEl = null;
function closeSrvMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openSrvMenu(btn, id) {
  closeSrvMenu();
  const s = srvById[id];
  const i = order.indexOf(id);
  const popped = poppedOut.has(id);
  menuEl = document.createElement("div");
  menuEl.className = "srv-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.setAttribute("aria-label", `${s.name} options`);
  menuEl.style.cssText = srvStyle(s);
  menuEl.innerHTML = `
    <div class="sm-h"><span class="srv-mark"></span>${esc(s.name)}</div>
    <button role="menuitemcheckbox" aria-checked="${!!s.quiet}" data-m="quiet">${I.quiet}<span><b>Quiet</b><small>No chimes, no bold, no arrival cards. Knocks still reach you.</small></span>${s.quiet ? I.check.replace("<svg", '<svg class="tick"') : ""}</button>
    <button role="menuitem" data-m="window">${I.popout}<span><b>${popped ? "Back in the list" : "Own window"}</b><small>${popped ? "Fold it back into your buddy list." : "A buddy list of its own, for raid night or a second screen."}</small></span></button>
    <div class="sm-sep"></div>
    <button role="menuitem" data-m="up" ${i === 0 ? "disabled" : ""}>${I.up}<span><b>Move up</b></span></button>
    <button role="menuitem" data-m="down" ${i === order.length - 1 ? "disabled" : ""}>${I.down}<span><b>Move down</b></span></button>`;
  document.body.append(menuEl);
  const r = btn.getBoundingClientRect();
  const w = 272;
  menuEl.style.left = `${Math.min(r.right - 8, innerWidth - w - 12)}px`;
  menuEl.style.top = `${Math.min(r.top, innerHeight - menuEl.offsetHeight - 12)}px`;
  menuEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b || b.disabled) return;
    const m = b.dataset.m;
    closeSrvMenu();
    if (m === "quiet") setQuiet(id, !s.quiet);
    if (m === "window") (popped ? popIn : popOut)(id);
    if (m === "up" || m === "down") {
      const j = m === "up" ? i - 1 : i + 1;
      [order[i], order[j]] = [order[j], order[i]];
      renderList();
    }
  });
  menuEl.addEventListener("keydown", (e) => {
    const items = [...menuEl.querySelectorAll("button:not([disabled])")];
    const k = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") items[(k + 1) % items.length].focus();
    if (e.key === "ArrowUp") items[(k - 1 + items.length) % items.length].focus();
    if (e.key === "Escape") {
      closeSrvMenu();
      btn.focus();
    }
    if (["ArrowDown", "ArrowUp", "Escape"].includes(e.key)) e.preventDefault();
  });
  menuEl.querySelector("button:not([disabled])")?.focus();
}
document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.contains(e.target) && !e.target.closest("[data-srv-menu]")) closeSrvMenu();
});

function setQuiet(id, on) {
  srvById[id].quiet = on;
  renderList();
}

function popOut(id) {
  const s = srvById[id];
  poppedOut.add(id);
  const main = wins.get("buddies");
  const x = main ? main.el.offsetLeft + main.el.offsetWidth + 14 : 340;
  const { h } = deskRect();
  openWindow(`srv-${id}`, {
    title: `<span class="srv-mark" aria-hidden="true"></span><span>${esc(s.name)}</span>${s.tz ? `<span class="sub">${esc(timeThere(s).text)}</span>` : ""}`,
    label: `${s.name}, in its own window`,
    kind: "srvlist",
    x, y: 22, w: 300, h: Math.min(h - 76, 820),
    build(win) {
      win.el.style.cssText += `;${srvStyle(s)}`;
      win.el.classList.add("has-srv");
      win.body.innerHTML = `<div class="bl"><div class="srv-card">${srvYou(s)}</div><div class="bl-scroll" data-srv-scroll="${id}"></div></div>`;
      const scroll = win.body.querySelector(".bl-scroll");
      win.body.querySelector(".bl").addEventListener("click", onListClick);
      scroll.addEventListener("dblclick", onListDblClick);
    },
  });
  renderList();
}

function popIn(id) {
  closeWindow(`srv-${id}`);
}

function openAddServer() {
  openWindow("add-server", {
    title: `${I.plus.replace("<svg", '<svg width="14" height="14" style="color:var(--ink-3)"')}<span>Add a server</span>`,
    label: "Add a server",
    kind: "away",
    x: 360, y: 180, w: 380, h: 300,
    build(win) {
      win.body.innerHTML = `
        <div class="away-form add-form">
          <label for="invite">Invite link</label>
          <input id="invite" class="invite" placeholder="Paste the link a host sent you" autocomplete="off" />
          <p class="add-note">Each server gives you its own account, so you can be somebody else there: another name, another look. It joins your list as a new section, at the bottom, where you can move it.</p>
          <div class="away-actions"><button class="pill-btn" data-a="cancel">Cancel</button><button class="pill-btn lamp" data-a="join" disabled>Join</button></div>
        </div>`;
      win.body.querySelector("[data-a=cancel]").addEventListener("click", () => closeWindow("add-server"));
    },
  });
}

// --- window manager --------------------------------------------------------

const wins = new Map(); // key -> { el, body, kind, float }
let z = 100;
let tiled = false;

// Tabs mode: one chat window, one pane per open conversation. Every pane stays
// in the page while its tab is open, so a hidden tab keeps its place and
// still receives messages.
const CHAT = "chat";
const tabs = new Map(); // conversation id -> { pane }
const tabOrder = [];
let activeTab = null;
const convOpen = (id) => wins.has(id) || tabs.has(id);
const convBody = (id) => wins.get(id)?.body ?? tabs.get(id)?.pane ?? null;
const openConvIds = () => [...[...wins.keys()].filter((k) => wins.get(k).kind === "conv"), ...tabs.keys()];

function deskRect() {
  return { w: desk.clientWidth, h: desk.clientHeight };
}

function place(el, { x, y, w, h }) {
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function focusWin(key) {
  for (const [k, win] of wins) win.el.classList.toggle("focused", k === key);
  const win = wins.get(key);
  if (win) win.el.style.zIndex = ++z;
}

function openWindow(key, { title, label, x, y, w, h, kind, build, focus = true, extra = "" }) {
  if (wins.has(key)) {
    focusWin(key);
    wins.get(key).el.querySelector("input, textarea, .stream")?.focus({ preventScroll: true });
    return wins.get(key);
  }
  const el = document.createElement("section");
  el.className = `win win-${kind}` + (reduced || still ? "" : " opening");
  el.dataset.key = key;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", label);
  el.innerHTML = `
    <div class="titlebar">
      <div class="title">${title}</div>
      ${extra}
      ${kind === "buddies" ? "" : `<button class="win-btn close" aria-label="Close ${esc(label)}">${I.close}</button>`}
    </div>
    <div class="win-body"></div>
    <div class="grip" aria-hidden="true"></div>`;
  desk.append(el);
  const win = { el, body: el.querySelector(".win-body"), kind, float: { x, y, w, h } };
  wins.set(key, win);
  place(el, win.float);
  build?.(win);
  el.addEventListener("pointerdown", () => focusWin(key), true);
  el.addEventListener("focusin", () => focusWin(key));
  el.querySelector(".close")?.addEventListener("click", () => closeWindow(key));
  drag(el, win, key);
  resize(el, win);
  if (focus) focusWin(key);
  if (tiled) tile(true);
  syncOpenRooms();
  return win;
}

function closeWindow(key) {
  const win = wins.get(key);
  if (!win) return;
  win.el.remove();
  wins.delete(key);
  // Closing the chat window closes its tabs. Voice is untouched: it belongs to
  // the room, and the voice bar in your list is still there.
  if (key === CHAT) {
    tabs.clear();
    tabOrder.length = 0;
    activeTab = null;
  }
  if (tiled) tile(true);
  const last = [...wins.keys()].at(-1);
  if (last) focusWin(last);
  syncOpenRooms();
  if (key === "settings") syncGear(false);
  // A server's own window folds back into the buddy list when it closes.
  if (key.startsWith("srv-")) {
    poppedOut.delete(key.slice(4));
    renderList();
  }
}

function drag(el, win, key) {
  const bar = el.querySelector(".titlebar");
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    if (tiled) setTiled(false);
    const start = { px: e.clientX, py: e.clientY, x: el.offsetLeft, y: el.offsetTop };
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const { w, h } = deskRect();
      const x = Math.min(Math.max(start.x + ev.clientX - start.px, -el.offsetWidth + 80), w - 80);
      const y = Math.min(Math.max(start.y + ev.clientY - start.py, 0), h - 40);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      win.float = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up, { once: true });
  });
}

function resize(el, win) {
  const grip = el.querySelector(".grip");
  grip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const start = { px: e.clientX, py: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      el.style.width = `${Math.max(260, start.w + ev.clientX - start.px)}px`;
      el.style.height = `${Math.max(180, start.h + ev.clientY - start.py)}px`;
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => {
      grip.removeEventListener("pointermove", move);
      win.float = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    }, { once: true });
  });
}

// Tiling: the buddy list keeps its width on the left, everything else shares
// the rest in columns, with the small gaps a tiling window manager uses.
function tile(instant = false) {
  const { w, h } = deskRect();
  const gap = 10;
  const list = wins.get("buddies");
  // A server in its own window is a buddy list too: it lines up beside the
  // main one.
  const lists = [...wins.values()].filter((v) => v.kind === "srvlist");
  const others = [...wins.entries()].filter(([k, v]) => k !== "buddies" && v.kind !== "srvlist").map(([, v]) => v);
  const listW = lists.length ? 284 : 304;
  desk.classList.toggle("animating", !instant);
  if (list) place(list.el, { x: gap, y: gap, w: listW, h: h - gap * 2 });
  lists.forEach((win, i) => place(win.el, { x: gap + (list ? 1 : 0) * (listW + gap) + i * (listW + gap), y: gap, w: listW, h: h - gap * 2 }));
  const left = gap + ((list ? 1 : 0) + lists.length) * (listW + gap);
  const avail = w - left - gap;
  if (MULTI && others.length === 2) {
    // With servers the first conversation is usually the busy one: give it
    // the larger share.
    const cw = (avail - gap) * 0.58;
    place(others[0].el, { x: left, y: gap, w: cw, h: h - gap * 2 });
    place(others[1].el, { x: left + cw + gap, y: gap, w: avail - cw - gap, h: h - gap * 2 });
  } else if (others.length <= 3) {
    const cw = (avail - gap * (others.length - 1)) / Math.max(others.length, 1);
    others.forEach((win, i) => place(win.el, { x: left + i * (cw + gap), y: gap, w: cw, h: h - gap * 2 }));
  } else {
    // Master and stack: the first conversation big, the rest stacked.
    const mw = avail * 0.55;
    place(others[0].el, { x: left, y: gap, w: mw, h: h - gap * 2 });
    const rest = others.slice(1);
    const rh = (h - gap * (rest.length + 1)) / rest.length;
    rest.forEach((win, i) => place(win.el, { x: left + mw + gap, y: gap + i * (rh + gap), w: avail - mw - gap, h: rh }));
  }
  setTimeout(() => desk.classList.remove("animating"), 300);
}

function setTiled(on) {
  tiled = on;
  desk.classList.toggle("tiled", on);
  document.getElementById("tile").setAttribute("aria-pressed", String(on));
  if (on) tile();
  else {
    desk.classList.add("animating");
    for (const win of wins.values()) place(win.el, win.float);
    setTimeout(() => desk.classList.remove("animating"), 300);
  }
}

document.getElementById("tile").addEventListener("click", () => setTiled(!tiled));
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea")) return;
  if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) setTiled(!tiled);
  if (e.key === "Escape") {
    const key = document.activeElement?.closest(".win")?.dataset.key;
    // Escape closes a small window, never the whole chat window and its tabs.
    if (key && key !== "buddies" && key !== CHAT) closeWindow(key);
  }
});
addEventListener("resize", () => tiled && tile(true));

// --- the buddy list --------------------------------------------------------

const collapsed = new Set(["offline", "ash:offline", "rib:offline"]);
let cardFor = null; // whose card is open

function buildBuddyList(win) {
  win.body.innerHTML = `
    <div class="bl">
      <div class="me" id="me"></div>
      <div class="bl-scroll" id="bl-scroll"></div>
      <section class="vdock" id="vdock" aria-label="Your voice" hidden></section>
      <div class="bl-foot">
        <button data-open="media">${I.media}<span>Media</span></button>
        <button data-open="search">${I.search}<span>Search</span></button>
      </div>
    </div>`;
  win.body.querySelector('[data-open="media"]').addEventListener("click", openMedia);
  win.body.querySelector('[data-open="search"]').addEventListener("click", openSearch);
  renderMe();
  renderList();
  const scroll = win.body.querySelector("#bl-scroll");
  scroll.addEventListener("click", onListClick);
  scroll.addEventListener("dblclick", onListDblClick);
  win.body.querySelector("#vdock").addEventListener("click", (e) => {
    const b = e.target.closest("[data-vd]");
    if (!b) return;
    const room = myVoiceRoom();
    if (b.dataset.vd === "go" && room) openConversation(room);
    if (b.dataset.vd === "mute") toggleMute();
    if (b.dataset.vd === "deafen") toggleDeafen();
    if (b.dataset.vd === "leave") leaveVoice();
  });
  win.el.querySelector("#settings-btn")?.addEventListener("click", () => (settings.isOpen() && wins.get(settings.KEY).el.classList.contains("focused") ? settings.close() : settings.open()));
  renderDock();
}

// The voice bar: the one place your voice controls live. It sits in the list,
// which is always open, so they're reachable from any tab or window.
function renderDock() {
  const el = document.getElementById("vdock");
  if (!el) return;
  const room = myVoiceRoom();
  if (!room) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const my = myVoice();
  const r = rooms.find((x) => x.id === room);
  const s = srvById[srvOf(room)];
  const inVoice = people.filter((p) => voiceRoomOf(p) === room).sort((a, b) => (a.you ? 1 : 0) - (b.you ? 1 : 0));
  const many = inVoice.length > 4;
  el.hidden = false;
  el.innerHTML = `
    <div class="vd-top">
      <span class="vo vd-vo" data-speak-room="${room}" style="--c:var(--lamp)">${I.speaker}<span class="bars"><i></i><i></i><i></i></span></span>
      <span class="vd-label">In voice</span>
      <button class="vd-room" data-vd="go" title="Go to #${esc(r.name)}" aria-label="In voice in #${esc(r.name)}${MULTI ? ` on ${esc(s.name)}` : ""}. Go to the room">
        <span class="hash">#</span><span class="vd-name">${esc(r.name)}</span>${I.go.replace("<svg", '<svg class="vd-go"')}
      </button>
    </div>
    ${MULTI ? `<div class="vd-sub"><span class="vd-srv" style="${srvStyle(s)}"><i aria-hidden="true"></i>${esc(s.name)}</span>${seatsWords(inVoice.length) ? `<span class="vd-seats">${seatsWords(inVoice.length)}</span>` : ""}</div>` : ""}
    <div class="vd-people ${many ? "many" : ""}">${inVoice
      .map((p) => `<span class="vd-p" data-speak="${p.id}" style="--c:${color(p.color)}" title="${esc(p.name)}">${dotHTML(p, "sm")}${many && !p.you ? "" : p.you ? '<span class="name you">you</span>' : nameHTML(p)}${p.you && p.muted ? I.micOff.replace("<svg", '<svg class="vd-muted"') : ""}</span>`)
      .join("")}</div>
    <div class="vd-btns">
      <button class="vd-btn ${my.muted ? "on" : ""}" data-vd="mute" aria-pressed="${!!my.muted}">${my.muted ? I.micOff : I.mic}<span>${my.muted ? "Unmute" : "Mute"}</span></button>
      <button class="vd-btn ${my.deafened ? "on" : ""}" data-vd="deafen" aria-pressed="${!!my.deafened}">${my.deafened ? I.headOff : I.head}<span>${my.deafened ? "Undeafen" : "Deafen"}</span></button>
      <button class="vd-btn leave" data-vd="leave">${I.leave}<span>Leave</span></button>
    </div>`;
  syncSpeaking();
}

function renderMe() {
  const el = document.getElementById("me");
  if (!el) return;
  const away = me.presence === "away";
  if (MULTI) {
    // With several servers the top card is only what's true everywhere: you,
    // and whether you're away. Your name and status live in each server.
    const awayOn = servers.filter((s) => meOf(s.id).presence === "away");
    el.classList.add("me-multi");
    el.innerHTML = `
      <div class="me-top">
        <div class="me-who">
          <div class="me-name">${nameHTML(me)}</div>
          <div class="me-where">${
            awayOn.length
              ? `${dotHTML({ ...me, presence: "away" }, "sm")}away${awayOn.length < servers.length ? ` on ${awayOn.map((s) => esc(s.name)).join(", ")}` : ""}`
              : `<span class="me-marks">${order.map((id) => `<i style="${srvStyle(srvById[id])}" title="${esc(srvById[id].name)}"></i>`).join("")}</span>around`
          }</div>
        </div>
        ${
          awayOn.length
            ? `<button class="pill-btn lamp me-away" id="back-btn">${I.sun}<span>I'm back</span></button>`
            : `<button class="pill-btn me-away" id="away-btn" title="Set an away message">${I.moon}<span>Away</span></button>`
        }
      </div>`;
    el.querySelector("#away-btn")?.addEventListener("click", openAway);
    el.querySelector("#back-btn")?.addEventListener("click", () => {
      for (const s of servers) {
        const my = meOf(s.id);
        if (my.presence !== "away") continue;
        if (s.id === "good") life.setAway(me.id, null);
        else Object.assign(my, { presence: "around", away: undefined, room: null });
      }
      renderMe();
      renderList();
    });
    return;
  }
  el.innerHTML = `
    <div class="me-top">
      <div class="me-who">
        <div class="me-name">${nameHTML(me)}</div>
        <div class="me-where">${dotHTML(me, "sm")}<span class="mw-text">${away ? `away${me.since && me.since !== "now" ? ` · ${me.since}` : ""}` : me.presence === "in_room" && me.room ? `in #${me.room}` : "around"}</span></div>
      </div>
      ${
        away
          ? `<button class="pill-btn lamp me-away" id="back-btn">${I.sun}<span>I'm back</span></button>`
          : `<button class="pill-btn me-away" id="away-btn" title="Set an away message">${I.moon}<span>Away</span></button>`
      }
    </div>
    ${
      away
        ? `<button class="me-status away-msg" id="me-status" aria-label="Your away message: ${esc(me.away)}. Change it">${I.moon.replace("<svg", '<svg class="pencil"')}<span>${esc(me.away)}</span></button>`
        : `<button class="me-status" id="me-status" aria-label="Your status: ${esc(me.status)}. Edit it">${I.pencil.replace("<svg", '<svg class="pencil"')}<span>${esc(me.status)}</span></button>`
    }
`;
  el.querySelector("#away-btn")?.addEventListener("click", openAway);
  el.querySelector("#back-btn")?.addEventListener("click", () => life.setAway(me.id, null));
  el.querySelector("#me-status").addEventListener("click", () => (away ? openAway() : editStatus()));
}

function editStatus() {
  const btn = document.getElementById("me-status");
  const input = document.createElement("input");
  input.className = "me-status-edit";
  input.value = me.status ?? "";
  input.maxLength = 240;
  input.setAttribute("aria-label", "Your status");
  btn.replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) life.setStatus(me.id, input.value.trim());
    else renderMe();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true), { once: true });
}

// Where someone is, in a few faint words.
const whereWords = (p) =>
  p.presence === "in_room" ? `in #${rname(p.room)}`
  : p.presence === "away" ? `away${p.since ? ` · ${p.since}` : ""}`
  : p.presence === "offline" ? `last here ${p.since ?? "a while ago"}`
  : p.presence === "idle" ? "idle"
  : "around";

// Everyone on a server, in one list: who's here first, then away, then
// offline. Not grouped by room: the rooms above already show who's where.
function peopleGroups(s = "good") {
  const others = peopleOf(s).filter((p) => !p.you);
  const rank = (p) => (voiceRoomOf(p) ? 0 : p.presence === "in_room" ? 1 : p.presence === "around" ? 2 : 3);
  return {
    here: others.filter((p) => ["in_room", "around", "idle"].includes(p.presence)).sort((a, b) => rank(a) - rank(b)),
    away: others.filter((p) => p.presence === "away"),
    offline: others.filter((p) => p.presence === "offline"),
  };
}

function buddyHTML(p) {
  let status;
  if (p.presence === "away") status = `“${esc(p.away)}”`;
  else if (p.presence === "offline") status = p.away ? `“${esc(p.away)}”` : "";
  else status = esc(p.status ?? "");
  // Every row keeps its second line, so the list has one rhythm.
  status ||= "&nbsp;";
  return `
    <li class="buddy p-${p.presence} ${cardFor === p.id ? "selected" : ""} ${life.state.knocked === p.id ? "knocking" : ""}" data-person="${p.id}">
      <button class="buddy-main" data-key="buddy-${p.id}" aria-haspopup="dialog" aria-expanded="${cardFor === p.id}" aria-label="${esc(p.name)}, ${esc(whereWords(p))}${p.voice ? ", in voice" : ""}. ${p.presence === "away" ? "Away: " + esc(p.away) : esc(p.status ?? "")}. Open their card">
        ${slotHTML([p])}
        <span class="buddy-text">
          <span class="buddy-top"><span class="buddy-name">${nameHTML(p)}${voiceMark(p)}</span><span class="buddy-where">${esc(whereWords(p))}</span></span>
          <span class="buddy-status">${status}</span>
        </span>
      </button>
      <span class="buddy-actions">
        <button class="act" data-act="knock" data-key="knock-${p.id}" aria-label="Knock on ${esc(p.name)}'s door" title="Knock">${I.knock}</button>
        <button class="act" data-act="message" data-key="msg-${p.id}" aria-label="Message ${esc(p.name)}" title="Message">${I.message}</button>
      </span>
      <span class="knocked-pill" role="status"><span>${I.knock.replace("<svg", '<svg width="11" height="11"')}knocked</span></span>
    </li>`;
}

// A room row: the activity view. Who's in it, and whether voice is on.
function roomRowHTML(r) {
  const here = people.filter((p) => p.presence === "in_room" && p.room === r.id);
  const talking = people.filter((p) => voiceRoomOf(p) === r.id);
  const mine = myVoiceRoom() === r.id;
  return `<li><button class="room-row ${r.fresh ? "fresh" : ""} ${convOpen(r.id) ? "open" : ""} ${talking.length ? "voiced" : ""}" data-room="${r.id}" data-key="room-${r.id}" aria-label="#${esc(r.name)}${r.fresh ? ", something new" : ""}${here.length ? ", " + here.map((p) => p.name).join(", ") + " in it" : ", nobody in"}${talking.length ? ", voice is on" : ""}">
    <span class="pm-slot hash" aria-hidden="true">#</span><span class="room-name">${esc(r.name)}</span>
    <span class="room-dots">${talking.length ? `<span class="vo room-vo ${mine ? "mine" : ""}" data-speak-room="${r.id}" title="${mine ? "You're in voice here" : "Voice is on"}">${I.speaker}<span class="bars"><i></i><i></i><i></i></span></span>` : ""}${here.map((p) => dotHTML(p, "sm")).join("")}</span>
  </button></li>`;
}

// Away and Offline inside People: the same small heading, the same caret.
// Away starts open, Offline folded; a folded one says "show".
function subGroup(key, label, list) {
  const open = !collapsed.has(key);
  return `<button class="sub-h sub-toggle ${open ? "" : "folded"}" data-group="${key}" data-key="group-${key}" aria-expanded="${open}">${I.caret.replace("<svg", '<svg class="caret"')}${label}<span class="sub-hint">${open ? "hide" : "show"}</span></button>
    ${open ? `<ul class="plist">${list.map(buddyHTML).join("")}</ul>` : ""}`;
}

const groupHead = (key, label, extra = "") =>
  `<div class="group-hd"><button class="group-h" data-group="${key}" data-key="group-${key}" aria-expanded="${!collapsed.has(key)}">${I.caret.replace("<svg", '<svg class="caret"')}${label}</button>${extra}</div>`;

// One server's rooms, DMs and people. With one server this is the whole list.
function sectionHTML(s = "good") {
  const kp = s === "good" ? "" : `${s}:`;
  const g = peopleGroups(s);
  const dmRows = dmsOf(s)
    .map((d) => {
      const others = d.members.filter((id) => !byId[id].you).map((id) => byId[id]);
      return `<li><button class="room-row dm-row ${d.fresh ? "fresh" : ""} ${convOpen(d.id) ? "open" : ""}" data-room="${d.id}" data-key="room-${d.id}" aria-label="DM with ${esc(dmTitle(d))}${d.fresh ? ", something new" : ""}">
        ${slotHTML(others)}
        <span class="room-name">${esc(dmTitle(d))}</span>
      </button></li>`;
    })
    .join("");
  return `
    <section class="rooms lead">
      ${groupHead(`${kp}rooms`, "Rooms")}
      <ul ${collapsed.has(`${kp}rooms`) ? "hidden" : ""}>${roomsOf(s).map(roomRowHTML).join("")}</ul>
    </section>
    <section class="rooms dms">
      ${groupHead(`${kp}dms`, "DMs", `<button class="hd-btn" data-new-dm="${s}" data-key="newdm-${s}" aria-label="New message${MULTI ? ` on ${esc(srvById[s].name)}` : ""}" title="New message">${I.compose}</button>`)}
      <ul ${collapsed.has(`${kp}dms`) ? "hidden" : ""}>${dmRows || `<li class="dm-empty">No DMs yet.</li>`}</ul>
    </section>
    <section class="people">
      ${groupHead(`${kp}people`, "People")}
      <div class="people-body" ${collapsed.has(`${kp}people`) ? "hidden" : ""}>
        <ul class="plist">${g.here.map(buddyHTML).join("")}</ul>
        ${g.away.length ? subGroup(`${kp}away`, "Away", g.away) : ""}
        ${g.offline.length ? subGroup(`${kp}offline`, "Offline", g.offline) : ""}
      </div>
    </section>`;
}

function paintList(scroll, html) {
  const focusKey = scroll.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  const top = scroll.scrollTop;
  scroll.innerHTML = html;
  scroll.scrollTop = top;
  if (focusKey) scroll.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
}

function renderList() {
  const scroll = document.getElementById("bl-scroll");
  if (scroll) paintList(scroll, MULTI ? serversHTML() : sectionHTML());
  for (const id of poppedOut) {
    const win = wins.get(`srv-${id}`);
    if (!win) continue;
    const card = win.body.querySelector(".srv-card");
    if (card) card.innerHTML = srvYou(srvById[id]);
    const box = win.body.querySelector(".bl-scroll");
    if (box) paintList(box, sectionHTML(id));
  }
  syncSpeaking();
}

function onListClick(e) {
  const toggle = e.target.closest("[data-srv-toggle]");
  if (toggle) {
    const id = toggle.dataset.srvToggle;
    if (poppedOut.has(id)) return focusWin(`srv-${id}`);
    folded.has(id) ? folded.delete(id) : folded.add(id);
    renderList();
    return;
  }
  const menu = e.target.closest("[data-srv-menu]");
  if (menu) return menuEl ? closeSrvMenu() : openSrvMenu(menu, menu.dataset.srvMenu);
  if (e.target.closest("[data-add-server]")) return openAddServer();
  const you = e.target.closest("[data-edit-status]");
  if (you) return editSrvStatus(you, you.dataset.editStatus);
  const group = e.target.closest("[data-group]");
  if (group) {
    const k = group.dataset.group;
    collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
    renderList();
    return;
  }
  const nd = e.target.closest("[data-new-dm]");
  if (nd) return openNewDM(nd.dataset.newDm);
  const act = e.target.closest("[data-act]");
  if (act) {
    const id = act.closest(".buddy").dataset.person;
    if (act.dataset.act === "knock") life.knock(id);
    else openDMWith(id);
    return;
  }
  const room = e.target.closest("[data-room]");
  if (room) return openConversation(room.dataset.room);
  const main = e.target.closest(".buddy-main");
  if (main) {
    // Click or Enter: their card, with Message and Knock on it. A second
    // click puts it away; a double-click goes straight to a DM.
    const id = main.closest(".buddy").dataset.person;
    return cardFor === id ? closeCard() : openCard(id, main);
  }
}

// Your status on one server, edited where it's shown.
function editSrvStatus(btn, id) {
  const my = meOf(id);
  const input = document.createElement("input");
  input.className = "me-status-edit srv-status-edit";
  input.value = my.status ?? "";
  input.maxLength = 240;
  input.setAttribute("aria-label", `Your status on ${srvById[id].name}`);
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    if (save && text && text !== my.status) {
      if (id === "good") life.setStatus(me.id, text);
      else my.status = text;
    }
    renderList();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function onListDblClick(e) {
  const main = e.target.closest(".buddy-main");
  if (!main) return;
  closeCard();
  openDMWith(main.closest(".buddy").dataset.person);
}

// --- a person's card ------------------------------------------------------
//
// Everything about them in one place, and the two things you can do: message
// them, or knock. It opens beside the list, from a click or Enter on their row.

let cardEl = null;
let cardAnchor = null;

function openCard(id, anchor) {
  closeCard();
  cardFor = id;
  cardAnchor = anchor;
  cardEl = document.createElement("div");
  cardEl.className = "pcard";
  cardEl.setAttribute("role", "dialog");
  document.body.append(cardEl);
  renderCard();
  placeCard();
  for (const li of document.querySelectorAll(".buddy")) li.classList.toggle("selected", li.dataset.person === id);
  anchor?.setAttribute("aria-expanded", "true");
  cardEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pc]");
    if (!b || b.disabled) return;
    if (b.dataset.pc === "close") return closeCard(true);
    if (b.dataset.pc === "knock") return life.knock(id);
    if (b.dataset.pc === "message") {
      closeCard();
      openDMWith(id);
    }
  });
  cardEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeCard(true);
    }
  });
  if (!still) cardEl.querySelector("[data-pc=message]")?.focus({ preventScroll: true });
}

function placeCard() {
  if (!cardEl || !cardAnchor) return;
  const list = cardAnchor.closest(".win") ?? wins.get("buddies")?.el;
  const lr = list.getBoundingClientRect();
  const rr = cardAnchor.getBoundingClientRect();
  const w = cardEl.offsetWidth;
  const h = cardEl.offsetHeight;
  const right = lr.right + 10 + w < innerWidth - 8;
  cardEl.style.left = `${right ? lr.right + 10 : lr.left - w - 10}px`;
  cardEl.style.top = `${Math.max(44, Math.min(rr.top - 10, innerHeight - h - 12))}px`;
  cardEl.classList.toggle("from-left", !right);
}

function renderCard() {
  if (!cardEl || !cardFor) return;
  const p = byId[cardFor];
  const knocked = life.state.knocked === p.id;
  const offline = p.presence === "offline";
  const lines = [
    p.listening && [I.note, "listening to", p.listening],
    p.reading && [I.book, "reading", p.reading],
    p.working && [I.pencil, "working on", p.working],
  ].filter(Boolean);
  const said = p.presence === "away" || offline ? p.away : p.status;
  cardEl.setAttribute("aria-label", `${p.name}'s card`);
  cardEl.style.setProperty("--c", color(p.color));
  cardEl.innerHTML = `
    <div class="pc-top">
      ${dotHTML(p)}
      <span class="pc-name">${nameHTML(p)}</span>${voiceMark(p)}
      <button class="win-btn pc-x" data-pc="close" aria-label="Close ${esc(p.name)}'s card">${I.close}</button>
    </div>
    <div class="pc-where">${esc(whereWords(p))}${voiceRoomOf(p) ? " · in voice" : ""}${MULTI ? srvTag(p.id) : ""}</div>
    ${said ? `<p class="pc-said ${p.presence === "away" || offline ? "away" : ""}" style="font-family:'${p.font}',var(--sans);font-style:${p.style ?? "normal"}">${p.presence === "away" || offline ? `${I.moon.replace("<svg", '<svg class="pc-moon"')}` : ""}${esc(said)}</p>` : ""}
    ${lines.length ? `<ul class="pc-lines">${lines.map(([icon, what, v]) => `<li>${icon}<span class="pc-what">${what}</span><span>${esc(v)}</span></li>`).join("")}</ul>` : ""}
    <div class="pc-btns">
      <button class="pill-btn lamp" data-pc="message">${I.message}<span>Message</span></button>
      <button class="pill-btn ${knocked ? "knocked" : ""}" data-pc="knock" ${offline ? `disabled title="They're offline, so a knock can't reach them."` : `title="A soft knock. Nothing to answer, nothing left behind."`}>${I.knock}<span>${knocked ? "knocked" : "Knock"}</span></button>
    </div>`;
  syncSpeaking();
}

function closeCard(refocus = false) {
  if (!cardEl) return;
  cardEl.remove();
  cardEl = null;
  const id = cardFor;
  cardFor = null;
  for (const li of document.querySelectorAll(".buddy.selected")) li.classList.remove("selected");
  cardAnchor?.setAttribute("aria-expanded", "false");
  if (refocus) document.querySelector(`[data-key="buddy-${CSS.escape(id)}"]`)?.focus();
  cardAnchor = null;
}
document.addEventListener("pointerdown", (e) => {
  if (cardEl && !cardEl.contains(e.target) && !e.target.closest(".buddy-main")) closeCard();
});

// --- a new message ----------------------------------------------------------
//
// Pick one to seven people from this server (a DM is two to eight, you
// included). The same people twice opens the same DM (SPEC §4.13).

function openNewDM(srv = "good", preset = []) {
  const picked = new Set(preset);
  let query = "";
  const s = srvById[srv];
  const me_ = meOf(srv);
  const list = wins.get("buddies")?.el.getBoundingClientRect();
  closeWindow("new-dm");
  openWindow("new-dm", {
    title: `${I.compose.replace("<svg", '<svg width="15" height="15" style="color:var(--ink-3)"')}<span>New message</span>${MULTI ? `<span class="srv-tag" style="${srvStyle(s)}"><i aria-hidden="true"></i>${esc(s.name)}</span>` : ""}`,
    label: "New message",
    kind: "newdm",
    x: list ? Math.round(list.right) + 14 : 360, y: 70, w: 380, h: 560,
    build(win) {
      win.el.style.setProperty("--acc", color(s.accent));
      const paint = () => {
        const q = query.trim().toLowerCase();
        const pool = peopleOf(srv).filter((p) => !p.you);
        const rank = (p) => (["in_room", "around", "idle"].includes(p.presence) ? 0 : p.presence === "away" ? 1 : 2);
        const shown = pool.filter((p) => !q || p.name.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b));
        const full = picked.size >= 7;
        const chosen = [...picked].map((id) => byId[id]);
        const existing = picked.size ? findDM(srv, [...picked]) : null;
        const names = chosen.map((p) => p.name);
        const who = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        win.body.innerHTML = `
          <div class="ndm">
            <div class="ndm-to">
              <span class="ndm-l">To</span>
              ${chosen.map((p) => `<button class="ndm-chip" data-unpick="${p.id}" aria-label="Remove ${esc(p.name)}">${dotHTML(p, "sm")}${nameHTML(p)}${I.close.replace("<svg", '<svg class="x"')}</button>`).join("")}
              <input class="ndm-find" placeholder="${chosen.length ? "Add someone" : "Find people"}" aria-label="Find people on ${esc(s.name)}" value="${esc(query)}" />
            </div>
            <ul class="ndm-list" role="listbox" aria-multiselectable="true" aria-label="People on ${esc(s.name)}">${
              shown.length
                ? shown
                    .map((p) => {
                      const on = picked.has(p.id);
                      const line = p.presence === "away" || p.presence === "offline" ? (p.away ? `“${esc(p.away)}”` : "") : esc(p.status ?? "");
                      return `<li><button class="ndm-p ${on ? "on" : ""}" role="option" aria-selected="${on}" data-pick="${p.id}" ${!on && full ? "disabled" : ""}>
                        ${slotHTML([p])}
                        <span class="ndm-t"><span class="ndm-n">${nameHTML(p)}<span class="buddy-where">${esc(whereWords(p))}</span></span><span class="ndm-s">${line || "&nbsp;"}</span></span>
                        <span class="ndm-check">${on ? I.check : ""}</span>
                      </button></li>`;
                    })
                    .join("")
                : `<li class="ndm-none">Nobody here by that name.</li>`
            }</ul>
            <div class="ndm-foot">
              <p class="ndm-say">${
                !picked.size
                  ? "Pick one person, or up to seven for a group."
                  : existing
                    ? `You already have a DM with ${esc(who)}. It opens where you left off.`
                    : `A new DM with ${esc(who)}${MULTI && srv !== "good" ? `, as ${esc(me_.name)}` : ""}.`
              }${full ? " That's everyone a DM can hold: eight, you included. A bigger group is a room." : ""}</p>
              <div class="away-actions"><button class="pill-btn" data-ndm="cancel">Cancel</button><button class="pill-btn lamp" data-ndm="go" ${picked.size ? "" : "disabled"}>${I.message}<span>${existing ? "Open the DM" : "Start the DM"}</span></button></div>
            </div>
          </div>`;
        const input = win.body.querySelector(".ndm-find");
        input.addEventListener("input", () => {
          query = input.value;
          const at = input.selectionStart;
          paint();
          const again = win.body.querySelector(".ndm-find");
          again.focus();
          again.setSelectionRange(at, at);
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const first = win.body.querySelector(".ndm-p:not([disabled]):not(.on)");
            if (query && first) {
              picked.add(first.dataset.pick);
              query = "";
              paint();
              win.body.querySelector(".ndm-find").focus();
            } else if (picked.size) go();
          }
          if (e.key === "Backspace" && !input.value && picked.size) {
            picked.delete([...picked].at(-1));
            paint();
            win.body.querySelector(".ndm-find").focus();
          }
        });
      };
      const go = () => {
        if (!picked.size) return;
        closeWindow("new-dm");
        openDMFor(srv, [...picked]);
      };
      win.body.addEventListener("click", (e) => {
        const pick = e.target.closest("[data-pick]");
        if (pick && !pick.disabled) {
          const id = pick.dataset.pick;
          picked.has(id) ? picked.delete(id) : picked.add(id);
          return paint();
        }
        const un = e.target.closest("[data-unpick]");
        if (un) {
          picked.delete(un.dataset.unpick);
          return paint();
        }
        const b = e.target.closest("[data-ndm]");
        if (b?.dataset.ndm === "cancel") closeWindow("new-dm");
        if (b?.dataset.ndm === "go") go();
      });
      paint();
      if (!still) win.body.querySelector(".ndm-find")?.focus();
    },
  });
}

function syncOpenRooms() {
  for (const b of document.querySelectorAll(".room-row[data-room]")) b.classList.toggle("open", convOpen(b.dataset.room));
}

// --- conversations ---------------------------------------------------------

function openDMWith(id) {
  openDMFor(srvOf(id), [id]);
}

// Asking for the same set of people again gives the same DM (SPEC §4.13). A
// DM belongs to the server all of you are on, as whoever you are there.
function findDM(srv, ids) {
  const want = [meOf(srv).id, ...ids].sort().join(",");
  return dms.find((d) => srvOf(d.id) === srv && [...d.members].sort().join(",") === want) ?? null;
}

function openDMFor(srv, ids) {
  let dm = findDM(srv, ids);
  if (!dm) {
    const short = ids.map((id) => (id.includes(":") ? id.split(":")[1] : id)).sort().join("-");
    dm = { id: srv === "good" ? `dm-${short}` : `${srv}:dm-${short}`, members: [meOf(srv).id, ...ids] };
    dms.push(dm);
    messages[dm.id] ??= [];
    renderList();
  }
  openConversation(dm.id);
}

let cascade = 0;

// Open a room or DM: a tab in the chat window, or a window of its own,
// whichever the setting says. A conversation already popped out into its own
// window stays there.
function openConversation(id, pos) {
  if (mode === "tabs" && !wins.has(id)) {
    ensureChat();
    addTab(id);
    showTab(id);
    return wins.get(CHAT);
  }
  return openConvWindow(id, pos);
}

function openConvWindow(id, pos, { popped = false } = {}) {
  const room = rooms.find((r) => r.id === id);
  const dm = room ? null : dms.find((d) => d.id === id);
  const others = dm ? dm.members.filter((m) => !byId[m].you).map((m) => byId[m]) : [];
  const { w, h } = deskRect();
  const at = pos ?? {
    x: Math.min(360 + cascade * 34, w - 520),
    y: Math.min(40 + cascade * 30, h - 560),
    w: room ? 560 : 460,
    h: room ? Math.min(760, h - 80) : 500,
  };
  cascade = (cascade + 1) % 6;
  const title = room
    ? `<span class="hash">#</span><span>${esc(room.name)}</span><span class="dots" data-dots="${id}"></span>${srvTag(id)}<span class="sub">${esc(room.topic)}</span>`
    : others.length === 1
      ? `${dotHTML(others[0])}<span style="font-size:15px">${nameHTML(others[0])}</span>${srvTag(id)}`
      : `<span class="dots">${others.map((p) => dotHTML(p, "sm")).join("")}</span>${others.map((p) => nameHTML(p)).join('<span class="sub">,</span>')}${srvTag(id)}`;
  const label = room ? `#${room.name}` : `DM with ${dmTitle(dm)}`;
  const s = srvById[srvOf(id)];
  // Popped out of the tabs: a way back.
  const extra = popped
    ? `<button class="win-txt-btn back-tabs" data-back-tabs="${id}" aria-label="Put ${esc(label)} back in the tabs" title="Back to tabs">${I.intoTabs}<span>Back to tabs</span></button>`
    : "";
  const win = openWindow(id, { title, label: MULTI ? `${label}, ${s.name}` : label, ...at, kind: "conv", extra, build: (w) => buildConversation(w, id, room, others) });
  if (MULTI) {
    // A thin stripe in the server's color, so #general here and #general
    // there can't be mixed up.
    win.el.classList.add("has-srv");
    win.el.style.setProperty("--acc", color(s.accent));
  }
  if (room) room.fresh = false;
  if (dm) dm.fresh = false;
  renderList();
  return win;
}

function buildConversation(win, id, room, others) {
  const placeholder = room ? `Say something in #${room.name}` : `Say something to ${others.map((p) => p.name).join(" and ")}`;
  win.body.innerHTML = `
    <div class="conv" data-conv="${id}">
      ${room ? `<div class="voice" data-voice="${id}"></div>` : `<div class="conv-info" data-info="${id}"></div>`}
      <div class="stream" tabindex="0" aria-label="Messages in ${esc(room ? "#" + room.name : dmTitle(dms.find((d) => d.id === id)))}"></div>
      <div class="typing" aria-live="polite"></div>
      <form class="composer">
        <span class="prompt" aria-hidden="true">›</span>
        <input aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}" autocomplete="off" />
        <button class="send" type="submit" aria-label="Send">${I.send}</button>
      </form>
    </div>`;
  win.body.querySelector(".composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    life.send(id, text);
  });
  win.body.querySelector(".stream").addEventListener("click", (e) => {
    const q = e.target.closest(".quote");
    if (!q) return;
    const target = win.body.querySelector(`#msg-${q.dataset.reply}`);
    target?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    target?.classList.remove("flash");
    void target?.offsetWidth;
    target?.classList.add("flash");
  });
  // Stay at the newest line when the window changes size (tiling, resizing),
  // unless you've scrolled up to read.
  const stream = win.body.querySelector(".stream");
  stream.addEventListener("scroll", () => {
    stream.dataset.stick = String(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40);
  }, { passive: true });
  new ResizeObserver(() => {
    if (stream.dataset.stick !== "false") stream.scrollTop = stream.scrollHeight;
  }).observe(stream);
  renderStream(id);
  renderVoice(id);
  renderInfo(id);
  renderTitleDots(id);
  renderTyping(id);
}

function renderStream(id, { live = null } = {}) {
  const stream = convBody(id)?.querySelector(".stream");
  if (!stream) return;
  const atEnd = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
  const html = [];
  for (const s of sessions(messages[id] ?? [])) {
    html.push(`<div class="divider"><span>${esc(s.label)}</span></div>`);
    for (const g of s.groups) {
      if (g.messages[0].leftOffBefore) html.push(`<div class="left-off" role="separator">you left off here</div>`);
      html.push(groupHTML(g, live, id));
    }
  }
  if (!html.length) {
    const dm = dms.find((d) => d.id === id);
    const names = dm ? dm.members.filter((m) => !byId[m].you).map((m) => nameHTML(byId[m])).join(" and ") : "";
    html.push(`<p class="empty-conv">Nothing here yet. Whatever you say stays between you and ${names}.</p>`);
  }
  stream.innerHTML = `<div class="stream-inner">${html.join("")}</div>`;
  if (atEnd || live || !stream.dataset.ready) {
    // Land where you left off if there's a marker, otherwise at the newest.
    const mark = !stream.dataset.ready && stream.querySelector(".left-off");
    if (mark) stream.scrollTop = mark.offsetTop - 60;
    else stream.scrollTop = stream.scrollHeight;
    stream.dataset.stick = String(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40);
  }
  // A hidden tab has no size to scroll in: it lands when it's first shown.
  if (stream.clientHeight) stream.dataset.ready = "1";
}

function groupHTML(g, live, roomId = "") {
  // What you send is from you as you are on that server.
  const p = g.author === me.id && MULTI && srvOf(roomId) !== "good" ? meOf(srvOf(roomId)) : byId[g.author];
  const first = g.messages[0];
  const quoted = first.replyTo ? findMessage(first.replyTo) : null;
  const quote = quoted
    ? `<button class="quote" data-reply="${quoted.id}" style="grid-column:1/-1" aria-label="Replying to ${esc(byId[quoted.author].name)}: ${esc(quoted.text)}">↩ ${nameHTML(byId[quoted.author])}<span class="q-text">${esc(quoted.text || "a link")}</span></button>`
    : "";
  const row0 = quoted ? 2 : 1;
  const lines = g.messages
    .map((m, i) => {
      const attach = m.image
        ? `<div class="attach"><img src="${m.image.src}" alt="${esc(m.image.alt)}" /></div>`
        : m.link
          ? `<div class="attach"><a class="linkcard" href="#" onclick="return false"><span class="lc-icon">${I.link}</span><span class="lc-t"><b>${esc(m.link.title)}</b><span>${esc(m.link.domain)}</span></span></a></div>`
          : "";
      return `<div class="line ${i === 0 ? "first" : ""} ${m.id === live ? "live" : ""}" id="msg-${m.id}" style="grid-column:2;grid-row:${row0 + i}">
        <time class="t" datetime="${m.time.toISOString()}" title="${m.time.toLocaleString()}">${fmtTime(m.time)}</time>
        ${m.text ? `<span class="text">${linkify(esc(m.text))}</span>` : ""}${attach}
      </div>`;
    })
    .join("");
  return `<div class="grp" style="display:grid;grid-template-columns:max-content minmax(0,1fr)">
    ${quote}
    <div class="who" style="grid-column:1;grid-row:${row0} / span ${g.messages.length}">${nameHTML(p)}<span class="colon">:</span></div>
    ${lines}
  </div>`;
}

const linkify = (s) => s.replace(/#([a-z-]+)/g, (m, r) => (rooms.some((x) => x.name === r) ? `<b>#${r}</b>` : m));

function renderTyping(id) {
  const el = convBody(id)?.querySelector(".typing");
  if (!el) return;
  const who = [...(life.state.typing[id] ?? [])].map((pid) => byId[pid]);
  el.innerHTML = who.length
    ? `${who.map((p) => nameHTML(p)).join(" and ")} is typing <span class="tdots" style="--c:${color(who[0].color)}"><i></i><i></i><i></i></span>`
    : "";
}

function renderVoice(id) {
  const el = convBody(id)?.querySelector(`[data-voice="${id}"]`);
  if (!el) return;
  const talking = people.filter((p) => voiceRoomOf(p) === id);
  // Voice is the room's, not the window's or the tab's. You're in voice in
  // at most one room, and its controls live in one place: the voice bar in
  // your list. Here the strip only says what's going on, and offers to bring
  // your voice over.
  const here = myVoiceRoom();
  const mine = here === id;
  const elsewhere = here && !mine ? rooms.find((r) => r.id === here) : null;
  const seats = MULTI ? seatsWords(talking.length) : "";
  const moveTitle = elsewhere ? ` title="Leaves voice in #${esc(elsewhere.name)} and talks here"` : "";
  if (!talking.length) {
    el.innerHTML = `<span class="v-icon" style="color:var(--ink-4)">${I.speaker}</span><span class="v-people v-words">Nobody's talking in here.</span><span class="v-btns"><button class="pill-btn" data-v="join"${moveTitle}>${I.mic}<span>${elsewhere ? "Talk here instead" : "Start talking"}</span></button></span>`;
  } else {
    const chips = talking
      .map((p) => `<span class="vp" data-speak="${p.id}" style="--c:${color(p.color)}">${dotHTML(p, "sm")}${p.you ? '<span class="name" style="font-weight:600">you</span>' : nameHTML(p)}${p.you && p.muted ? I.micOff.replace("<svg", '<svg width="12" height="12"') : ""}</span>`)
      .join("");
    const words = mine ? "" : talking.length === 1 ? "is talking" : "are talking";
    el.innerHTML = `<span class="v-icon">${I.speaker}</span><span class="v-people">${chips}<span class="v-words">${words}${seats ? `<span class="seats">${words ? " · " : ""}${seats}</span>` : ""}</span></span>
      <span class="v-btns">${
        mine
          ? `<span class="v-here" title="Mute, deafen and leave are in the voice bar in your list">You're in voice here</span>`
          : elsewhere
            ? `<button class="pill-btn" data-v="join"${moveTitle}>${I.mic}<span>Move voice here</span></button>`
            : `<button class="pill-btn lamp" data-v="join">${I.mic}<span>Join</span></button>`
      }</span>`;
  }
  el.classList.toggle("mine", mine);
  el.querySelector("[data-v=join]")?.addEventListener("click", () => joinVoice(id));
  syncSpeaking();
}

function renderInfo(id) {
  const el = convBody(id)?.querySelector(`[data-info="${id}"]`);
  if (!el) return;
  const dm = dms.find((d) => d.id === id);
  const others = dm.members.filter((m) => !byId[m].you).map((m) => byId[m]);
  if (others.length === 1) {
    const p = others[0];
    const glyph = glyphFor(p);
    const where = p.presence === "in_room" ? `in #${p.room}` : p.presence === "away" ? `away · ${p.since}` : p.presence === "offline" ? `last here ${p.since}` : "around";
    const words = p.presence === "away" || p.presence === "offline" ? `“${esc(p.away ?? "")}”` : esc(p.status ?? "");
    const extra = p.listening ? `<span class="ci-glyph">${I.note}</span>${esc(p.listening)}` : p.reading ? `<span class="ci-glyph">${I.book}</span>${esc(p.reading)}` : "";
    el.innerHTML = `<span class="ci-text"><b>${where}</b> · ${words}${extra}</span>
      <button class="pill-btn ${life.state.knocked === p.id ? "knocked" : ""}" data-knock="${p.id}" aria-label="Knock on ${esc(p.name)}'s door">${I.knock}<span>${life.state.knocked === p.id ? "knocked" : "Knock"}</span></button>`;
    el.querySelector("[data-knock]").addEventListener("click", () => life.knock(p.id));
    void glyph;
  } else {
    el.innerHTML = `<span class="ci-text">${others.map((p) => `${dotHTML(p, "sm")} <b>${esc(p.name)}</b> ${p.presence === "away" ? `“${esc(p.away)}”` : p.presence === "in_room" ? `in #${p.room}` : p.presence}`).join(" &nbsp; ")}</span>`;
  }
}

function renderTitleDots(id) {
  // In a window's title bar, or in a tab's header.
  const html = people.filter((p) => p.presence === "in_room" && p.room === id).map((p) => dotHTML(p, "sm")).join("");
  for (const el of document.querySelectorAll(`[data-dots="${CSS.escape(id)}"]`)) el.innerHTML = html;
}

// A muted you is never shown talking.
const talkingNow = (id) => life.state.speaking.has(id) && !(byId[id]?.you && byId[id].muted);

function syncSpeaking() {
  for (const el of document.querySelectorAll("[data-speak]")) {
    el.classList.toggle("speaking", talkingNow(el.dataset.speak));
  }
  // A room's speaker (on its tab, and in the voice bar) moves while anyone
  // in there is talking.
  for (const el of document.querySelectorAll("[data-speak-room]")) {
    const room = el.dataset.speakRoom;
    el.classList.toggle("speaking", [...life.state.speaking].some((id) => talkingNow(id) && byId[id] && voiceRoomOf(byId[id]) === room));
  }
}

// --- tabs: one chat window ---------------------------------------------------
//
// Tabs mode keeps every conversation in one window whose title bar is a row of
// tabs, like a browser. Opening a room adds a tab (or shows it if it's open).
// Any tab can be popped out into its own window and put back. The prototype
// uses Alt+←/→, Alt+1…9 and Alt+W because a browser keeps Ctrl+Tab and Ctrl+W
// for itself; the desktop app would use Ctrl+Tab and Ctrl+W.

const safeId = (id) => id.replace(/[^a-z0-9_-]/gi, "_");
const targetOf = (id) => rooms.find((r) => r.id === id) ?? dms.find((d) => d.id === id);
const plainLabel = (id) => {
  const room = rooms.find((r) => r.id === id);
  return room ? `#${room.name}` : dmTitle(dms.find((d) => d.id === id));
};
const KEYS_HINT = "Alt+← → to switch tabs, Alt+1–9 to jump, Alt+W to close";

function ensureChat(box) {
  if (wins.has(CHAT)) return wins.get(CHAT);
  const { w, h } = deskRect();
  const list = wins.get("buddies");
  const x = list ? list.el.offsetLeft + list.el.offsetWidth + 18 : 360;
  const at = box ?? { x, y: 22, w: Math.min(780, w - x - 28), h: Math.min(h - 76, 820) };
  return openWindow(CHAT, {
    title: `<div class="tabs" role="tablist" aria-label="Open conversations. ${KEYS_HINT}"></div>`,
    label: "the chat window and all its tabs",
    kind: "chat",
    ...at,
    build(win) {
      win.body.innerHTML = `<div class="panes"></div>`;
      wireStrip(win.el.querySelector(".tabs"));
    },
  });
}

function addTab(id) {
  if (tabs.has(id)) return;
  const chat = ensureChat();
  const room = rooms.find((r) => r.id === id);
  const dm = room ? null : dms.find((d) => d.id === id);
  if (!room && !dm) return;
  const others = dm ? dm.members.filter((m) => !byId[m].you).map((m) => byId[m]) : [];
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.id = `pane-${safeId(id)}`;
  pane.setAttribute("role", "tabpanel");
  pane.setAttribute("aria-labelledby", `tab-${safeId(id)}`);
  pane.hidden = true;
  // A room's tab gets the header its window's title bar would have had.
  pane.innerHTML = room
    ? `<div class="pane-head"><span class="hash">#</span><span class="ph-name">${esc(room.name)}</span><span class="dots" data-dots="${id}"></span>${srvTag(id)}<span class="sub">${esc(room.topic)}</span></div><div class="pane-conv"></div>`
    : `<div class="pane-conv"></div>`;
  chat.body.querySelector(".panes").append(pane);
  tabs.set(id, { pane });
  tabOrder.push(id);
  buildConversation({ body: pane.querySelector(".pane-conv") }, id, room, others);
  renderTabs();
  syncOpenRooms();
}

function showTab(id, { focus = null } = {}) {
  if (!tabs.has(id)) return;
  activeTab = id;
  for (const [k, t] of tabs) t.pane.hidden = k !== id;
  const target = targetOf(id);
  if (target) target.fresh = false;
  const stream = tabs.get(id).pane.querySelector(".stream");
  if (stream && !stream.dataset.ready) renderStream(id);
  enterRoom(id);
  renderTabs();
  renderList();
  focusWin(CHAT);
  if (focus === "composer") tabs.get(id).pane.querySelector(".composer input")?.focus({ preventScroll: true });
  if (focus === "tab") wins.get(CHAT)?.el.querySelector(`[data-tab-go="${CSS.escape(id)}"]`)?.focus();
  const tabEl = wins.get(CHAT)?.el.querySelector(`.tab[data-tab="${CSS.escape(id)}"]`);
  tabEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// The room you're looking at is the room you're in (SPEC §4.1). Your voice
// stays where it is.
function enterRoom(id) {
  if (!rooms.some((r) => r.id === id)) return; // a DM doesn't move you
  const s = srvOf(id);
  for (const srv of servers) {
    const my = meOf(srv.id);
    if (!my || my.presence === "away") continue;
    if (srv.id === s) {
      if (my.presence === "in_room" && my.room === id) continue;
      if (my === me) life.enter(id);
      else {
        const from = my.presence;
        Object.assign(my, { presence: "in_room", room: id });
        onLife("presence", { person: my, from });
      }
    } else if (MULTI && my.presence === "in_room") {
      // Looking at another server's room: here you're just around.
      const from = my.presence;
      Object.assign(my, { presence: "around", room: null });
      onLife("presence", { person: my, from });
    }
  }
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const i = tabOrder.indexOf(id);
  t.pane.remove();
  tabs.delete(id);
  tabOrder.splice(i, 1);
  if (!tabOrder.length) {
    closeWindow(CHAT);
    renderList();
    return;
  }
  if (activeTab === id) showTab(tabOrder[Math.min(i, tabOrder.length - 1)]);
  else renderTabs();
  syncOpenRooms();
}

function renderTabs() {
  const strip = wins.get(CHAT)?.el.querySelector(".tabs");
  if (!strip) return;
  const mine = myVoiceRoom();
  const focusKey = strip.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  strip.innerHTML = tabOrder
    .map((id, i) => {
      const target = targetOf(id);
      const room = rooms.find((r) => r.id === id);
      const dm = room ? null : target;
      const s = srvById[srvOf(id)];
      const active = id === activeTab;
      const fresh = target?.fresh && !active;
      const othersTalking = people.some((p) => !p.you && voiceRoomOf(p) === id);
      const voice =
        mine === id
          ? `<span class="vo tab-vo mine" data-speak-room="${id}" style="--c:var(--lamp)" title="You're in voice here">${I.speaker}<span class="bars"><i></i><i></i><i></i></span></span>`
          : othersTalking
            ? `<span class="vo tab-vo" data-speak-room="${id}" title="People are talking here">${I.speaker}<span class="bars"><i></i><i></i><i></i></span></span>`
            : "";
      let label;
      if (room) label = `<span class="hash">#</span><span class="tab-name">${esc(room.name)}</span>`;
      else {
        const others = dm.members.filter((m) => !byId[m].you).map((m) => byId[m]);
        // Plain text, as in the list, so a DM with something new can go bold.
        label =
          others.length === 1
            ? `${dotHTML(others[0], "sm")}<span class="tab-name">${esc(others[0].name)}</span>`
            : `<span class="tab-dots">${others.map((p) => dotHTML(p, "sm")).join("")}</span><span class="tab-name">${esc(others.map((p) => p.name).join(", "))}</span>`;
      }
      const plain = plainLabel(id);
      const aria = `${plain}${MULTI ? `, ${s.name}` : ""}${fresh ? ", something new" : ""}${mine === id ? ", you're in voice here" : othersTalking ? ", people talking" : ""}`;
      return `<div class="tab ${active ? "active" : ""} ${fresh ? "fresh" : ""}" data-tab="${id}" style="${MULTI ? srvStyle(s) : ""}">
        <button class="tab-main" role="tab" id="tab-${safeId(id)}" data-key="tab-${id}" aria-selected="${active}" aria-controls="pane-${safeId(id)}" tabindex="${active ? 0 : -1}" data-tab-go="${id}" aria-label="${esc(aria)}" title="${esc(`${plain}${MULTI ? ` · ${s.name}` : ""}${i < 9 ? ` (Alt+${i + 1})` : ""}\n${KEYS_HINT}`)}">${label}${voice}</button>
        <button class="tab-btn tab-pop" data-tab-pop="${id}" data-key="pop-${id}" tabindex="-1" aria-label="Pop ${esc(plain)} out into its own window" title="Pop out into its own window">${I.popout}</button>
        <button class="tab-btn tab-x" data-tab-close="${id}" data-key="x-${id}" tabindex="-1" aria-label="Close ${esc(plain)}" title="Close tab (Alt+W)">${I.close}</button>
      </div>`;
    })
    .join("");
  if (focusKey) strip.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  syncSpeaking();
}

// Clicks, middle-click to close, arrow keys between tabs, and dragging: along
// the strip to reorder, off it to pop the tab out into its own window.
function wireStrip(strip) {
  let justDragged = false;
  strip.addEventListener("click", (e) => {
    if (justDragged) return (justDragged = false);
    const pop = e.target.closest("[data-tab-pop]");
    if (pop) return popOutTab(pop.dataset.tabPop);
    const x = e.target.closest("[data-tab-close]");
    if (x) return closeTab(x.dataset.tabClose);
    const go = e.target.closest("[data-tab-go]");
    if (go) showTab(go.dataset.tabGo, { focus: e.detail === 0 ? "tab" : null });
  });
  strip.addEventListener("auxclick", (e) => {
    const tab = e.target.closest(".tab");
    if (e.button === 1 && tab) closeTab(tab.dataset.tab);
  });
  strip.addEventListener("keydown", (e) => {
    const go = e.target.closest("[data-tab-go]");
    if (!go || e.altKey) return;
    const i = tabOrder.indexOf(go.dataset.tabGo);
    const n = tabOrder.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to !== null) {
      e.preventDefault();
      showTab(tabOrder[to], { focus: "tab" });
    }
    if (e.key === "Delete") {
      e.preventDefault();
      closeTab(go.dataset.tabGo);
    }
  });
  strip.addEventListener("pointerdown", (e) => {
    const main = e.target.closest(".tab-main");
    if (!main || e.button !== 0) return;
    const id = main.dataset.tabGo;
    const tabEl = main.closest(".tab");
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    main.setPointerCapture(e.pointerId);
    const off = (ev) => {
      const r = strip.getBoundingClientRect();
      return ev.clientY > r.bottom + 36 || ev.clientY < r.top - 36;
    };
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      if (!dragging && Math.hypot(dx, ev.clientY - start.y) < 6) return;
      dragging = true;
      tabEl.classList.add("dragging");
      tabEl.classList.toggle("tearing", off(ev));
      tabEl.style.transform = off(ev) ? `translate(${dx}px, ${ev.clientY - start.y}px)` : `translateX(${dx}px)`;
    };
    const up = (ev) => {
      main.removeEventListener("pointermove", move);
      tabEl.style.transform = "";
      tabEl.classList.remove("dragging", "tearing");
      if (!dragging) return;
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      if (off(ev)) {
        const d = desk.getBoundingClientRect();
        popOutTab(id, { x: ev.clientX - d.left - 90, y: Math.max(0, ev.clientY - d.top - 16) });
        return;
      }
      // Drop it where the pointer is among the other tabs.
      const others = tabOrder.filter((t) => t !== id);
      let at = 0;
      for (const t of others) {
        const r = strip.querySelector(`.tab[data-tab="${CSS.escape(t)}"]`).getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) at++;
      }
      tabOrder.splice(0, tabOrder.length, ...others.slice(0, at), id, ...others.slice(at));
      renderTabs();
    };
    main.addEventListener("pointermove", move);
    main.addEventListener("pointerup", up, { once: true });
  });
}

// Keyboard: Alt+←/→ (or Alt+[ ]), Alt+1…9, Alt+W. Works from the message box
// too, so you can read another room without reaching for the mouse.
document.addEventListener("keydown", (e) => {
  if (mode !== "tabs" || !tabOrder.length || !e.altKey || e.ctrlKey || e.metaKey) return;
  const n = tabOrder.length;
  const i = Math.max(0, tabOrder.indexOf(activeTab));
  let to = null;
  if (e.code === "ArrowRight" || e.code === "BracketRight") to = (i + 1) % n;
  else if (e.code === "ArrowLeft" || e.code === "BracketLeft") to = (i - 1 + n) % n;
  else if (/^Digit[1-9]$/.test(e.code)) to = e.code === "Digit9" ? n - 1 : Math.min(Number(e.code.slice(5)), n) - 1;
  else if (e.code === "KeyW") {
    e.preventDefault();
    closeTab(activeTab);
    return;
  } else return;
  e.preventDefault();
  const typing = document.activeElement?.closest(".composer");
  showTab(tabOrder[to], { focus: typing ? "composer" : "tab" });
});

// Drafts travel with a conversation when it moves between a tab and a window.
function takeDraft(id) {
  const input = convBody(id)?.querySelector(".composer input");
  return input?.value ?? "";
}
function putDraft(id, text) {
  const input = convBody(id)?.querySelector(".composer input");
  if (input && text) input.value = text;
}

function popOutTab(id, pos) {
  const draft = takeDraft(id);
  const chat = wins.get(CHAT);
  const box = chat?.float;
  closeTab(id);
  const { w, h } = deskRect();
  const at = pos
    ? { x: Math.min(Math.max(pos.x, 0), w - 420), y: Math.min(pos.y, h - 420), w: 460, h: Math.min(560, h - 60) }
    : box
      ? { x: Math.min(box.x + box.w + 14, w - 440), y: box.y + 40, w: 440, h: Math.min(box.h - 60, 620) }
      : undefined;
  openConvWindow(id, at, { popped: true });
  putDraft(id, draft);
}

function backToTabs(id) {
  const draft = takeDraft(id);
  closeWindow(id);
  ensureChat();
  addTab(id);
  showTab(id);
  putDraft(id, draft);
}
desk.addEventListener("click", (e) => {
  const b = e.target.closest("[data-back-tabs]");
  if (b) backToTabs(b.dataset.backTabs);
});

// Switching the setting moves what's open, live: tabs become windows, or
// every conversation window gathers into one tabbed window.
function setMode(next) {
  if (next === mode) return;
  if (next === "tabs") {
    const convs = [...wins.entries()].filter(([, v]) => v.kind === "conv");
    const focused = convs.find(([, v]) => v.el.classList.contains("focused"))?.[0] ?? convs.at(-1)?.[0];
    const box = convs[0]?.[1].float;
    const drafts = convs.map(([k]) => [k, takeDraft(k)]);
    mode = next;
    for (const [k] of convs) closeWindow(k);
    if (convs.length) {
      const { w, h } = deskRect();
      ensureChat(box ? { x: box.x, y: box.y, w: Math.min(Math.max(box.w, 680), w - box.x - 16), h: Math.max(box.h, Math.min(560, h - 40)) } : undefined);
      for (const [k] of convs) addTab(k);
      showTab(focused);
      for (const [k, t] of drafts) putDraft(k, t);
    }
  } else {
    const ids = [...tabOrder];
    const vis = activeTab;
    const box = wins.get(CHAT)?.float;
    const drafts = ids.map((k) => [k, takeDraft(k)]);
    mode = next;
    closeWindow(CHAT);
    const { w, h } = deskRect();
    ids.forEach((id, i) => {
      const at = box
        ? { x: Math.min(box.x + i * 34, w - 480), y: Math.min(box.y + i * 30, h - 480), w: Math.min(box.w, 560), h: Math.min(box.h, 640) }
        : undefined;
      openConvWindow(id, at);
    });
    if (vis) focusWin(vis);
    for (const [k, t] of drafts) putDraft(k, t);
  }
  document.documentElement.classList.toggle("tabs-mode", mode === "tabs");
  renderList();
  settings?.paint();
}

// --- settings --------------------------------------------------------------
//
// Its own window, built in settings.js. It's created further down, once
// everything it reaches for exists.

let settings = null;
function syncGear(on) {
  document.getElementById("settings-btn")?.setAttribute("aria-expanded", String(on));
}

// --- small windows ---------------------------------------------------------

const presets = ["back after work", "asleep 💤", "walking the dog 🐕", "out on the porch, phone inside", "at dinner, back in a bit 🍝", "reading. knock if it's good"];

function openAway() {
  const { w } = deskRect();
  openWindow("away", {
    title: `${I.moon.replace("<svg", '<svg width="14" height="14" style="color:var(--lamp)"')}<span>Away message</span>`,
    label: "Away message",
    kind: "away",
    x: 340, y: MULTI ? 90 : 150, w: 360, h: MULTI ? 600 : 470,
    build(win) {
      const current = me.away ?? presets[0];
      win.body.innerHTML = `
        <div class="away-form">
          <label for="away-text">What should friends see?</label>
          <textarea id="away-text" maxlength="240">${esc(current)}</textarea>
          <div class="presets" role="group" aria-label="Saved away messages">
            ${presets.map((t) => `<button class="preset" aria-pressed="${t === current}" data-preset="${esc(t)}">${I.moon.replace("<svg", '<svg class="moon"')}${esc(t)}</button>`).join("")}
          </div>
          ${
            MULTI
              ? `<fieldset class="show-on"><legend>Show on</legend>${order
                  .map((id) => {
                    const s = srvById[id];
                    return `<label style="${srvStyle(s)}"><input type="checkbox" data-srv="${id}" checked /><span class="srv-mark" aria-hidden="true"></span><span class="so-name">${esc(s.name)}</span><span class="so-as">as ${nameHTML(meOf(id))}</span></label>`;
                  })
                  .join("")}</fieldset>`
              : ""
          }
          <p class="away-preview">Friends see ${dotHTML({ ...me, presence: "away" }, "sm")} ${nameHTML(me)} <span class="ap-msg">“${esc(current)}”</span></p>
          <div class="away-actions">
            <button class="pill-btn" data-a="cancel">Cancel</button>
            <button class="pill-btn lamp" data-a="go">${I.moon}<span>I'm away</span></button>
          </div>
        </div>`;
      const ta = win.body.querySelector("textarea");
      const preview = win.body.querySelector(".ap-msg");
      const sync = () => {
        preview.textContent = `“${ta.value}”`;
        for (const b of win.body.querySelectorAll(".preset")) b.setAttribute("aria-pressed", String(b.dataset.preset === ta.value));
      };
      ta.addEventListener("input", sync);
      win.body.querySelector(".presets").addEventListener("click", (e) => {
        const b = e.target.closest(".preset");
        if (!b) return;
        ta.value = b.dataset.preset;
        sync();
      });
      win.body.querySelector("[data-a=cancel]").addEventListener("click", () => closeWindow("away"));
      win.body.querySelector("[data-a=go]").addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) return;
        if (MULTI) {
          // Away everywhere you ticked, and nowhere else: the guild doesn't
          // need to know you're at the doctor.
          for (const box of win.body.querySelectorAll(".show-on input:checked")) {
            const id = box.dataset.srv;
            if (id === "good") life.setAway(me.id, text);
            else Object.assign(meOf(id), { presence: "away", away: text, since: "now", voice: false });
          }
          renderMe();
          renderList();
        } else life.setAway(me.id, text);
        closeWindow("away");
      });
      void w;
    },
  });
}

function openMedia() {
  openWindow("media", {
    title: `${I.media.replace("<svg", '<svg width="15" height="15" style="color:var(--ink-3)"')}<span>Media</span><span class="sub">everything the group has shared</span>`,
    label: "Media",
    kind: "media",
    x: 420, y: 90, w: 560, h: 420,
    build(win) {
      const items = [...media].sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.time - a.time);
      win.body.innerHTML = `<div class="media-grid">${items
        .map((m) => `<article class="media-item">
          <div class="mi-art">${m.src ? `<img src="${m.src}" alt="" />` : I[m.kind] ?? I.file}</div>
          <div class="mi-t"><b>${m.starred ? `<span class="star" title="starred">${I.star.replace("<svg", '<svg width="11" height="11" style="vertical-align:-1px"')}</span> ` : ""}${esc(m.title)}</b><span>${nameHTML(byId[m.by])} · #${esc(m.room)} · ${m.time.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></div>
        </article>`)
        .join("")}</div>`;
    },
  });
}

function openSearch() {
  openWindow("search", {
    title: `${I.search.replace("<svg", '<svg width="15" height="15" style="color:var(--ink-3)"')}<span>Search</span>`,
    label: "Search",
    kind: "search",
    x: 460, y: 120, w: 480, h: 480,
    build(win) {
      win.body.innerHTML = `<div class="search"><input type="search" placeholder="Search rooms and your DMs" aria-label="Search rooms and your DMs" value="porch" /><div class="results" aria-live="polite"></div></div>`;
      const input = win.body.querySelector("input");
      const out = win.body.querySelector(".results");
      const run = () => {
        const q = input.value.trim().toLowerCase();
        if (!q) return (out.innerHTML = `<p class="empty">Type to search.</p>`);
        const hits = [];
        for (const [rid, list] of Object.entries(messages)) {
          for (const m of list) if (m.text.toLowerCase().includes(q)) hits.push([rid, m]);
        }
        const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
        out.innerHTML = hits.length
          ? hits
              .sort((a, b) => b[1].time - a[1].time)
              .map(([rid, m]) => `<button class="result" data-r="${rid}" data-m="${m.id}"><div class="r-meta">${nameHTML(byId[m.author])}<span>${esc(roomName(rid))}</span><span>${esc(sessionLabel(m.time))}, ${fmtTime(m.time)}</span></div>${esc(m.text).replace(re, "<mark>$1</mark>")}</button>`)
              .join("")
          : `<p class="empty">Nothing yet for “${esc(input.value)}”.</p>`;
      };
      input.addEventListener("input", run);
      out.addEventListener("click", (e) => {
        const r = e.target.closest(".result");
        if (!r) return;
        openConversation(r.dataset.r);
        requestAnimationFrame(() => {
          const t = convBody(r.dataset.r)?.querySelector(`#msg-${r.dataset.m}`);
          t?.scrollIntoView({ block: "center" });
          t?.classList.add("flash");
        });
      });
      run();
    },
  });
}

// --- door toasts and sounds ------------------------------------------------

// Both live in Settings → Sound & Voice. Arrival cards are on and door sounds
// are off until you turn them on.
let sounds = false;
let cards = true;
let audio = null;

function chime(force = false, notes = [659.25, 880]) {
  if (!sounds && !force) return;
  audio ??= new AudioContext();
  const t = audio.currentTime;
  for (const [i, f] of notes.map((f, i) => [i, f])) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.035, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.6);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.12);
    o.stop(t + i * 0.12 + 0.7);
  }
}

// A short preview for Settings' Play buttons: always sounds, whatever the switches say.
const PREVIEWS = { door: [659.25, 880], voice: [523.25, 659.25], controls: [784], dms: [880, 1046.5], rooms: [698.46], knocks: [392, 392] };
function preview(kind) {
  chime(true, PREVIEWS[kind] ?? PREVIEWS.door);
}

function toast(html, { icon = I.door, stay = false, srv = null, arrival = false } = {}) {
  if (arrival && !cards) return;
  const el = document.createElement("div");
  el.className = "toast";
  const s = MULTI && srv ? srvById[srv] : null;
  el.innerHTML = `<span class="door">${icon}</span><span>${html}${s ? `<span class="toast-srv" style="${srvStyle(s)}"><i aria-hidden="true"></i>${esc(s.name)}</span>` : ""}</span>`;
  toasts.append(el);
  if (!s?.quiet) chime();
  if (!stay) {
    setTimeout(() => el.classList.add("out"), 5200);
    setTimeout(() => el.remove(), 5600);
  }
}

// Somebody knocking on *your* door: the buddy list gives two soft taps and a
// card says who. Nothing to answer, nothing left behind (SPEC §4.9).
function knockedOnMe(id) {
  const p = byId[id];
  // Knocks from any server come to the list, even a quiet one's.
  toast(`${nameHTML(p)} knocked. <span style="color:var(--ink-3)">Just saying hi.</span>`, { icon: I.knock, srv: srvOf(id) });
  const el = wins.get("buddies")?.el;
  if (!el || reduced) return;
  el.classList.remove("knocked-on");
  void el.offsetWidth;
  el.classList.add("knocked-on");
}

// --- life ------------------------------------------------------------------

function onLife(type, d) {
  if (type === "message") {
    const { roomId, msg } = d;
    if (convOpen(roomId)) renderStream(roomId, { live: msg.id });
    // Open but in a tab you're not looking at: the tab goes bold, like the
    // room in the list. Weight only, never a number.
    const unseen = !convOpen(roomId) || (tabs.has(roomId) && activeTab !== roomId);
    if (unseen && !people.find((p) => p.id === msg.author)?.you) {
      const target = rooms.find((r) => r.id === roomId) ?? dms.find((x) => x.id === roomId);
      if (target) target.fresh = true; // weight change only, never a number
      renderList();
      renderTabs();
    }
    renderTyping(roomId);
  }
  if (type === "typing") renderTyping(d.roomId);
  if (type === "presence") {
    const p = d.person;
    renderList();
    if (p.you) renderMe();
    for (const key of openConvIds()) {
      renderVoice(key);
      renderTitleDots(key);
      renderInfo(key);
    }
    renderTabs();
    renderDock();
    if (cardFor === p.id) renderCard();
    // A quiet server shows no arrival cards.
    if (!p.you && !srvById[srvOf(p.id)].quiet) {
      const srv = srvOf(p.id);
      if (p.presence === "in_room" && d.from !== "in_room") toast(`${nameHTML(p)} came into <b>#${esc(rname(p.room))}</b>`, { srv, arrival: true });
      else if (p.presence === "in_room") toast(`${nameHTML(p)} went over to <b>#${esc(rname(p.room))}</b>`, { srv, arrival: true });
      else if (p.presence === "around" && d.from === "away") toast(`${nameHTML(p)} is back`, { icon: I.sun, srv, arrival: true });
      else if (p.presence === "away") toast(`${nameHTML(p)} stepped away`, { icon: I.moon, srv, arrival: true });
    }
  }
  if (type === "voice") {
    renderList();
    for (const key of openConvIds()) renderVoice(key);
    renderTabs();
    renderDock();
  }
  if (type === "speaking") syncSpeaking();
  if (type === "status") {
    renderMe();
    if (MULTI) renderList();
  }
  if (type === "knock" || type === "knock-reset") {
    for (const li of document.querySelectorAll(`.buddy[data-person="${d.id}"]`)) li.classList.toggle("knocking", type === "knock");
    for (const key of openConvIds()) renderInfo(key);
    if (cardFor === d.id) renderCard();
  }
  if (type === "enter") {
    renderList();
    renderMe();
  }
}
life.on(onLife);

// --- settings, wired to everything above ------------------------------------

// Everything that shows a name, drawn again: after you save a new look, or
// turn plain names on or off.
function refreshAll() {
  renderMe();
  renderList();
  for (const id of openConvIds()) {
    renderStream(id);
    renderVoice(id);
    renderTyping(id);
    if (!rooms.some((r) => r.id === id)) renderInfo(id);
  }
  renderTabs();
  renderDock();
  renderCard();
}

settings = createSettings({
  I, esc, nameHTML, color, dotHTML, MULTI,
  me, people, rooms, srvOf, order, srvById, meOf, timeThere, poppedOut,
  hostServer: srvById.good,
  setQuiet, popOut, popIn, renderList, openAddServer, refreshAll,
  getMode: () => mode,
  setMode,
  getCards: () => cards,
  setCards: (on) => (cards = on),
  getDoor: () => sounds,
  setDoor: (on) => (sounds = on),
  preview,
  now: () => life.now(),
  isPlain: () => document.documentElement.classList.contains("plain"),
  setPlain: (on) => {
    document.documentElement.classList.toggle("plain", on);
    refreshAll();
  },
  wins, openWindow, closeWindow, focusWin, deskRect, syncGear,
});

// Ctrl+, opens Settings, as it does in most desktop apps.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ",") {
    e.preventDefault();
    settings.open();
  }
});

// --- first paint -----------------------------------------------------------

function clock() {
  const t = life.now();
  document.getElementById("clock").textContent = `${t.toLocaleDateString("en-US", { weekday: "short" })} ${fmtTime(t)}`;
}
clock();
setInterval(clock, 15000);

const { w: DW, h: DH } = deskRect();
openWindow("buddies", {
  title: `${markHTML(MARK)}<span class="bl-title">${MULTI ? "Linger" : esc(server.name)}</span>`,
  label: "Buddy list",
  kind: "buddies",
  // A little wider with several servers, so a folded server's line fits.
  x: MULTI ? 22 : 28, y: 22, w: MULTI ? 322 : 304, h: Math.min(DH - 76, 820),
  build: buildBuddyList,
  focus: false,
  extra: `<button class="win-btn gear" id="settings-btn" aria-expanded="false" aria-label="Settings" title="Settings (Ctrl+,)">${I.gear}</button>`,
});
if (mode === "tabs") {
  // One chat window beside the list, holding what would have been two windows.
  const x = (MULTI ? 22 + 322 : 28 + 304) + 18;
  ensureChat({ x, y: 22, w: Math.min(780, DW - x - 28), h: Math.min(DH - 76, 820) });
  for (const id of MULTI ? ["general", "rib:geral"] : ["general", "dm-jules"]) addTab(id);
  showTab("general");
} else if (MULTI) {
  openConversation("general", { x: 360, y: 22, w: Math.min(560, DW - 900), h: Math.min(DH - 76, 820) });
  openConversation("rib:geral", { x: Math.min(944, DW - 480), y: 64, w: 460, h: Math.min(DH - 150, 640) });
} else {
  openConversation("general", { x: 360, y: 22, w: Math.min(600, DW - 860), h: Math.min(DH - 76, 820) });
  openConversation("dm-jules", { x: Math.min(930, DW - 480), y: 74, w: 450, h: 440 });
}
cascade = 2;

// Fonts arrive after the first layout and make lines taller: land again.
document.fonts.ready.then(() => {
  for (const stream of desk.querySelectorAll(".stream")) {
    if (!stream.clientHeight) continue; // a hidden tab lands when it's shown
    const mark = stream.querySelector(".left-off");
    stream.scrollTop = mark ? mark.offsetTop - 60 : stream.scrollHeight;
  }
});

life.start();
if (!still) setTimeout(() => knockedOnMe("jules"), 40000);

// The other servers get a little life of their own. The shared script only
// knows The Good Company, so these are posted directly.
function post(roomId, author, text) {
  life.state.typing[roomId]?.delete(author);
  const msg = { id: `live${Math.random().toString(36).slice(2, 8)}`, author, time: life.now(), text, live: true };
  (messages[roomId] ??= []).push(msg);
  onLife("message", { roomId, msg });
}
function typeIn(roomId, author) {
  (life.state.typing[roomId] ??= new Set()).add(author);
  onLife("typing", { roomId, who: author, on: true });
}
function arrive(id, presence, room = null, extra = {}) {
  const p = byId[id];
  const from = p.presence;
  Object.assign(p, { presence, room }, extra);
  onLife("presence", { person: p, from });
}
if (MULTI && !still) {
  const at = (s, fn) => setTimeout(fn, s * 1000);
  at(5, () => typeIn("ash:loot-council", "ash:morrow"));
  at(8, () => post("ash:loot-council", "ash:morrow", "reminder: rolls after the kill, it's in the spreadsheet"));
  at(13, () => typeIn("ash:raid-night", "ash:kestrel"));
  at(15, () => post("ash:raid-night", "ash:kestrel", "PULLING. good luck all"));
  at(21, () => typeIn("rib:geral", "rib:rui"));
  at(24, () => post("rib:geral", "rib:rui", "ok going to try sleeping again. boa noite ☕"));
  at(33, () => arrive("ash:tansy", "around", null, { away: undefined, since: undefined }));
  at(47, () => post("ash:raid-night", "ash:sable", "WE GOT IT 🎉"));
  at(49, () => post("ash:raid-night", "ash:oxbow", "finally. moths: 0, us: 1"));
  at(58, () => knockedOnMe("rib:rui"));
}

// Hooks for screenshots and for poking at it from the console.
window.lab = {
  life,
  open: openConversation,
  close: closeWindow,
  closeAll: () => [...wins.keys()].filter((k) => k !== "buddies").forEach(closeWindow),
  tile: () => setTiled(true),
  away: openAway,
  media: openMedia,
  search: openSearch,
  knock: (id) => life.knock(id),
  expand: (key) => {
    collapsed.delete(key);
    renderList();
  },
  // A person's card, as if their row were clicked.
  card: (id) => openCard(id, document.querySelector(`[data-key="buddy-${CSS.escape(id)}"]`)),
  select: (id) => openCard(id, document.querySelector(`[data-key="buddy-${CSS.escape(id)}"]`)),
  closeCard,
  newDM: (srv = "good", preset = []) => openNewDM(srv, preset),
  focus: focusWin,
  place: (key, box) => {
    const win = wins.get(key);
    if (!win) return;
    win.float = box;
    place(win.el, box);
  },
  typing: (roomId, id) => {
    (life.state.typing[roomId] ??= new Set()).add(id);
    renderTyping(roomId);
  },
  arrive: (id, room) => {
    const p = byId[id];
    const from = p.presence;
    Object.assign(p, { presence: room ? "in_room" : "around", room: room ?? null });
    onLife("presence", { person: p, from });
  },
  toast,
  knockedOnMe,
  // Servers (with ?servers).
  fold: (id, on = true) => {
    on ? folded.add(id) : folded.delete(id);
    renderList();
  },
  quiet: setQuiet,
  popOut,
  popIn,
  // Tabs and voice.
  mode: setMode,
  settings: (section) => settings.open(section),
  closeSettings: () => settings.close(),
  openTab: (id) => {
    ensureChat();
    addTab(id);
  },
  showTab,
  closeTab,
  popTab: popOutTab,
  backToTabs,
  orderTabs: (ids) => {
    tabOrder.splice(0, tabOrder.length, ...ids.filter((id) => tabs.has(id)), ...tabOrder.filter((id) => !ids.includes(id)));
    renderTabs();
  },
  joinVoice,
  leaveVoice,
  mute: toggleMute,
  deafen: toggleDeafen,
  speak: (ids) => {
    life.state.speaking = new Set(ids);
    syncSpeaking();
  },
  post,
  typeIn,
  // arrive() above keeps its one-server meaning; this one takes a presence.
  moveTo: arrive,
  scrollList: (to) => {
    const s = document.getElementById("bl-scroll");
    if (s) s.scrollTop = to === "end" ? s.scrollHeight : to;
  },
  NOW,
  // A stand-in for whatever else is on your screen, for the "leave it open"
  // picture. It shows nothing about any real app.
  otherWindow: (box) =>
    openWindow("other", {
      title: `<span class="sub">your other windows</span>`,
      label: "Placeholder for your other windows",
      kind: "other",
      ...box,
      focus: false,
      build(win) {
        const bars = (n, seed) => Array.from({ length: n }, (_, i) => `<i style="width:${40 + ((i * 37 + seed) % 55)}%"></i>`).join("");
        win.body.innerHTML = `<div class="skeleton"><div class="sk-side">${bars(9, 11)}</div><div class="sk-main"><b></b>${bars(6, 3)}<u></u>${bars(7, 29)}</div></div>`;
      },
    }),
};
