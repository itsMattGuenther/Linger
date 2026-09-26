/**
 * What search and media find on the evening's servers, for the new client's
 * search and media test pages (`next-search.tsx`, `next-media.tsx`).
 *
 * The Good Company's words are the evening's own messages (`evening.ts`).
 * The guild and Lisbon (`servers.ts`) have no messages there, so a few are
 * added here, with "porch" among them, so one search finds something on
 * every server. The media is what those conversations shared: the speakers
 * photo and the river trail link, and a few more of every kind.
 *
 * `fakeSearch` and `fakeMedia` answer like the server does (PROTOCOL §6):
 * all words, whole words, "quoted phrases", newest first; starred first,
 * then newest; keyset pages by cursor.
 */
import type { Attachment } from "../../../src/generated/Attachment";
import type { MediaItem } from "../../../src/generated/MediaItem";
import type { MediaKind } from "../../../src/generated/MediaKind";
import type { Message } from "../../../src/generated/Message";
import type { SearchHit } from "../../../src/generated/SearchHit";
import type { SearchSnippetPart } from "../../../src/generated/SearchSnippetPart";
import { messages as eveningMessages, NOW, previews, SERVER, SPEAKERS_PHOTO, TRAIL_URL } from "./evening";
import { GUILD, LISBON } from "./servers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A small picture of a given shape, drawn so it needs no file. */
function picture(width: number, height: number, sky: string, ground: string): string {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${sky}"/><rect y="${height * 0.62}" width="${width}" height="${height * 0.38}" fill="${ground}"/><circle cx="${width * 0.72}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.1}" fill="#ffe7a8"/></svg>`,
    )
  );
}

/** Pictures by the path a server would give for them. */
export const PICTURES: Record<string, string> = {
  "/media/speakers.png": SPEAKERS_PHOTO,
  "/media/moon-over-the-porch.png": picture(300, 400, "#1d2340", "#2c2233"),
  "/media/porch-timelapse.jpg": picture(640, 360, "#31405e", "#3b2e2a"),
  "/media/raid-wipe.png": picture(800, 450, "#2a1f3a", "#1a1a24"),
  "/media/rio.jpg": picture(500, 500, "#3e5a78", "#26455a"),
};

/** A message on one of the other servers. */
function said(id: string, room_id: string, author_id: string, created_at: number, body: string, attachments: Attachment[] = []): Message {
  return { id, room_id, author_id, body, reply_to: null, attachments, reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at };
}

function upload(id: string, uploader_id: string, created_at: number, filename: string, mime: string, size_bytes: number, extra: Partial<Attachment> = {}): Attachment {
  return {
    id,
    filename,
    mime,
    size_bytes,
    url: `/media/${filename}`,
    width: null,
    height: null,
    duration_ms: null,
    blurhash: null,
    poster_url: null,
    starred_at: null,
    uploader_id,
    created_at,
    ...extra,
  };
}

const lootSheet = upload("g-loot", "a-morrow", NOW - 2 * HOUR, "loot-council.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48_200);
const wipe = upload("g-wipe", "a-kestrel", NOW - 50 * 60_000, "raid-wipe.png", "image/png", 912_400, { width: 800, height: 450 });
const rio = upload("l-rio", "l-rui", NOW - 5 * HOUR, "rio.jpg", "image/jpeg", 1_320_000, { width: 500, height: 500 });

/** Every server's messages by room, newest last. */
export const conversations: Record<string, Record<string, Message[]>> = {
  [SERVER]: eveningMessages,
  [GUILD]: {
    "a-general": [
      said("m000901", "a-general", "a-grimwald", NOW - 26 * HOUR, "who has the key to the guild hall porch? the snacks are out there"),
      said("m000902", "a-general", "a-pip", NOW - 3 * HOUR, "first raid tonight, any tips?"),
      said("m000903", "a-general", "a-kestrel", NOW - 2 * HOUR, "tips: stand behind Bramble, never in front of the porch dragon"),
    ],
    "a-raid-night": [said("m000913", "a-raid-night", "a-kestrel", NOW - 50 * 60_000, "that was the wipe of the century", [wipe])],
    "a-loot-council": [said("m000915", "a-loot-council", "a-morrow", NOW - 2 * HOUR, "spreadsheet updated, sorted by who needs it most", [lootSheet])],
    "a-dm-nyx": [said("m000920", "a-dm-nyx", "a-nyx", NOW - HOUR, "save me a seat on the porch after the raid")],
  },
  [LISBON]: {
    "l-geral": [
      said("m000801", "l-geral", "l-rui", NOW - 30 * HOUR, "bom dia! who's up?"),
      said("m000806", "l-geral", "l-ines", NOW - 7 * HOUR, "the porch at the café is open again"),
    ],
    "l-fotos": [said("m000808", "l-fotos", "l-rui", NOW - 5 * HOUR, "the river this morning", [rio])],
    "l-dm-ines": [said("m000811", "l-dm-ines", "l-ines", NOW - 8 * HOUR, "dinner on the porch next week?")],
  },
};

// --- search ------------------------------------------------------------------

/** Whole words, with simple English endings folded, as the server's index does ("photo" finds "photos"). */
function fold(word: string): string {
  const lower = word.toLowerCase();
  return lower.length > 3 && lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The query's phrases: a quoted run is one, every other word is its own. */
function phrases(q: string): string[][] {
  const out: string[][] = [];
  const rest = q.replace(/"([^"]*)"/g, (_, inside: string) => {
    const words = [...inside.matchAll(WORD)].map((m) => fold(m[0]));
    if (words.length > 0) out.push(words);
    return " ";
  });
  for (const m of rest.matchAll(WORD)) out.push([fold(m[0])]);
  return out;
}

function hasRun(words: string[], run: string[]): boolean {
  return words.some((_, at) => run.every((word, offset) => words[at + offset] === word));
}

/** The body cut into runs, with every word of the query marked. */
function snippet(body: string, wanted: Set<string>): SearchSnippetPart[] {
  const parts: SearchSnippetPart[] = [];
  let last = 0;
  for (const m of body.matchAll(WORD)) {
    const at = m.index ?? 0;
    if (!wanted.has(fold(m[0]))) continue;
    if (at > last) parts.push({ text: body.slice(last, at), matched: false });
    parts.push({ text: m[0], matched: true });
    last = at + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), matched: false });
  return parts.filter((part) => part.text !== "");
}

/** What `GET /search` answers on a server: hits, newest first, a page after `before`. */
export function fakeSearch(server: string, ask: { q: string; room: string | null; author: string | null; before: string | null; limit: number }, extra: Message[] = []): SearchHit[] {
  const runs = phrases(ask.q);
  const wanted = new Set(runs.flat());
  const all = [...Object.values(conversations[server] ?? {}).flat(), ...extra]
    .filter((message) => (ask.room === null || message.room_id === ask.room) && (ask.author === null || message.author_id === ask.author))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  const hits = all.flatMap((message): SearchHit[] => {
    const words = [...message.body.matchAll(WORD)].map((m) => fold(m[0]));
    const inWords = runs.every((run) => hasRun(words, run));
    const files = message.attachments.map((file) => file.filename).filter((name) => {
      const named = [...name.matchAll(WORD)].map((m) => fold(m[0]));
      return runs.every((run) => hasRun(named, run));
    });
    if (!inWords && files.length === 0) return [];
    return [
      {
        message_id: message.id,
        room_id: message.room_id,
        author_id: message.author_id,
        created_at: message.created_at,
        cursor: message.id,
        snippet: inWords ? snippet(message.body, wanted) : message.body === "" ? [] : [{ text: message.body, matched: false }],
        matched_filenames: files,
      },
    ];
  });
  const from = ask.before === null ? 0 : hits.findIndex((hit) => hit.cursor === ask.before) + 1;
  return hits.slice(from, from + ask.limit);
}

// --- media -------------------------------------------------------------------

function item(kind: MediaKind, author_id: string, created_at: number, room_id: string, message_id: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { kind, cursor: extra.attachment?.id ?? message_id, author_id, created_at, message_id, room_id, attachment: null, link: null, excerpt: null, starred_at: null, ...extra };
}

function fileItem(kind: MediaKind, file: Attachment, room_id: string, message_id: string, excerpt: string | null = null): MediaItem {
  return item(kind, file.uploader_id, file.created_at, room_id, message_id, { attachment: file, excerpt, starred_at: file.starred_at });
}

const at = (day: number, hour: number, minute: number) => new Date(2026, 8, 25 + day, hour, minute).getTime();
const speakers = upload("a-speakers", "u-jules", at(0, 16, 7), "speakers.png", "image/png", 184_320, { width: 400, height: 250 });
const moon = upload("a-moon", "u-callie", at(-1, 23, 14), "moon-over-the-porch.png", "image/png", 402_000, { width: 300, height: 400, starred_at: at(-1, 23, 20) });
const timelapse = upload("a-timelapse", "u-matt", at(-2, 20, 30), "porch-timelapse.mp4", "video/mp4", 38_400_000, {
  width: 640,
  height: 360,
  duration_ms: 247_000,
  poster_url: "/media/porch-timelapse.jpg",
});
const rain = upload("a-rain", "u-eli", at(0, 22, 49), "rain-sounds.mp3", "audio/mpeg", 5_800_000, { duration_ms: 3_725_000 });
const map = upload("a-map", "u-sam", at(-1, 18, 22), "river-loop-trail-map.pdf", "application/pdf", 2_100_000);

/** Every server's media, in the server's order: starred first, then newest. */
export const collections: Record<string, MediaItem[]> = {
  [SERVER]: [
    fileItem("image", moon, "r-general", "m000002", "that's not the porch light, that's the moon"),
    fileItem("audio", rain, "r-general", "m000015"),
    item("link", "u-jules", at(0, 22, 43), "r-general", "m000013", { link: previews[TRAIL_URL] ?? null, excerpt: TRAIL_URL }),
    fileItem("image", speakers, "r-general", "m000007", "exhibit a"),
    fileItem("file", map, "r-plans", "m000021"),
    item("pin", "u-sam", at(-1, 18, 20), "r-plans", "m000021", { excerpt: "saturday walk, 9am? meet at the trailhead" }),
    fileItem("video", timelapse, "r-general", "m000110"),
  ],
  [GUILD]: [fileItem("image", wipe, "a-raid-night", "m000913"), fileItem("file", lootSheet, "a-loot-council", "m000915")],
  [LISBON]: [fileItem("image", rio, "l-fotos", "m000808")],
};

/** A long run of shared things, for paging: every other one a picture. */
export function manyItems(): MediaItem[] {
  return Array.from({ length: 150 }, (_, index) => {
    const when = NOW - (index + 1) * DAY;
    const name = `evening-${String(index + 1).padStart(3, "0")}`;
    const file =
      index % 2 === 0
        ? upload(`a-many-${index}`, "u-jules", when, `${name}.png`, "image/png", 90_000 + index, { width: 400, height: 250, url: "/media/speakers.png" })
        : upload(`a-many-${index}`, "u-dave", when, `${name}.pdf`, "application/pdf", 40_000 + index);
    return fileItem(file.mime.startsWith("image/") ? "image" : "file", file, "r-general", `m${String(500_000 + index)}`);
  });
}

/** What `GET /media` answers on a server: starred first, then newest, a page after `before`. */
export function fakeMedia(
  all: readonly MediaItem[],
  ask: { kind: MediaKind | null; author: string | null; since: number | null; until: number | null; before: string | null; limit: number },
): MediaItem[] {
  const matching = all
    .filter((one) => (ask.kind === null || one.kind === ask.kind) && (ask.author === null || one.author_id === ask.author))
    .filter((one) => (ask.since === null || one.created_at >= ask.since) && (ask.until === null || one.created_at <= ask.until))
    .sort((a, b) => Number(b.starred_at !== null) - Number(a.starred_at !== null) || b.created_at - a.created_at);
  const from = ask.before === null ? 0 : matching.findIndex((one) => one.cursor === ask.before) + 1;
  return matching.slice(from, from + ask.limit);
}
