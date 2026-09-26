/**
 * The media collection's words and rules (SPEC §4.4, parity MEDIA-1…6).
 * Pure; `app/media/MediaView` draws what these say.
 *
 * The arithmetic shared with today's client (sizes, lengths, the day a date
 * field means, what a tile is called) is in `lib/media.ts`. This file is the
 * new client's side: the filters, what a tile says, the order several
 * servers merge in, and the lines that say how a star or a page went.
 */
import type { MediaItem } from "../../generated/MediaItem";
import type { MediaKind } from "../../generated/MediaKind";
import type { User } from "../../generated/User";
import type { UserId } from "../../generated/UserId";
import { dayEnd, dayStart, durationText, expiryText, fileSize, itemLabel, KIND_FILTERS } from "../../lib/media";
import { fullTime } from "../../lib/time";
import { inWhere, type Directory } from "./search";

/** A page. Big enough that scrolling is rare, small enough to arrive fast. */
export const MEDIA_PAGE = 60;

/** What the grid is narrowed to. The dates are `YYYY-MM-DD` as a date field gives them, empty when unset. */
export interface MediaFilters {
  kind: MediaKind | null;
  author: UserId | null;
  from: string;
  to: string;
}

export const NO_FILTERS: MediaFilters = { kind: null, author: null, from: "", to: "" };

export function isFiltered(filters: MediaFilters): boolean {
  return filters.kind !== null || filters.author !== null || filters.from !== "" || filters.to !== "";
}

/** The kinds, in `lib/media`'s order, as a button says them. */
export const KINDS: readonly { key: MediaKind | null; label: string }[] = KIND_FILTERS.map(({ key, label }) => ({
  key,
  label: label.charAt(0).toUpperCase() + label.slice(1),
}));

/**
 * What to ask a server for, or why not to ask. A range that ends before it
 * starts is refused by the server; saying so here spends no request.
 */
export function mediaAsk(filters: MediaFilters): { kind: MediaKind | null; author: UserId | null; since: number | null; until: number | null } | string {
  if (filters.from !== "" && filters.to !== "" && filters.from > filters.to) return "The dates are the wrong way round: the first is after the second.";
  return { kind: filters.kind, author: filters.author, since: dayStart(filters.from), until: dayEnd(filters.to) };
}

/** Starred first, then newest: the servers' own order (PROTOCOL §6), for merging several. */
export function mediaOrder(a: MediaItem, b: MediaItem): number {
  const starred = Number(b.starred_at !== null) - Number(a.starred_at !== null);
  return starred !== 0 ? starred : b.created_at - a.created_at;
}

/** What the tile's face draws. */
export type Face =
  | { kind: "image"; path: string; width: number | null; height: number | null }
  | { kind: "video"; poster: string | null; length: string | null }
  | { kind: "link"; icon: string | null; domain: string }
  | { kind: "glyph"; of: MediaKind; word: string };

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Everything one tile says. */
export interface TileLine {
  face: Face;
  /** Its name: a file's, a link's title, a pinned message's words. */
  title: string;
  who: User | undefined;
  whoName: string;
  /** Where it was shared; undefined when that room has been archived. */
  where: string | undefined;
  /** Where is a DM, named by who's in it. */
  dm: boolean;
  /** The server's name, when items from several servers are mixed; otherwise null. */
  serverName: string | null;
  /** The day it was shared, and the full moment for its tooltip. */
  date: string;
  moment: string;
  /** A file's size; null for a link or a pin. */
  size: string | null;
  /** Only an upload can be starred (PROTOCOL §6): a link or a pin has nothing to keep. */
  starrable: boolean;
  starred: boolean;
  /** Whether it can take you to its message: not when the message or its room has gone. */
  opens: boolean;
  /** The whole tile as one line, for a screen reader. */
  label: string;
}

const WORD: Record<MediaKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  file: "File",
  link: "Link",
  pin: "Pinned",
};

function faceOf(item: MediaItem): Face {
  const file = item.attachment;
  if (item.kind === "image" && file) return { kind: "image", path: file.url, width: file.width, height: file.height };
  if (item.kind === "video" && file) return { kind: "video", poster: file.poster_url, length: file.duration_ms === null ? null : durationText(Number(file.duration_ms)) };
  if (item.kind === "link" && item.link) return { kind: "link", icon: item.link.icon, domain: item.link.domain };
  const word = WORD[item.kind];
  if (item.kind === "audio" && file && file.duration_ms !== null) return { kind: "glyph", of: "audio", word: `${word} · ${durationText(Number(file.duration_ms))}` };
  return { kind: "glyph", of: item.kind, word };
}

/**
 * What one tile says: what it is, who shared it, where and when, and its
 * size. Every tile leads back to its message (MEDIA-4), so where and when
 * are always on it, not only what it's called.
 */
export function tileLine(item: MediaItem, names: Directory, serverName: string | null): TileLine {
  const who = names.person(item.author_id);
  const whoName = who?.display_name ?? "someone";
  const where = item.room_id === null ? undefined : names.where(item.room_id);
  const file = item.attachment;
  const title = itemLabel(item);
  const starred = item.starred_at !== null;
  const noun = item.kind === "pin" ? "Pinned message" : WORD[item.kind];
  const dm = item.room_id !== null && names.isDm(item.room_id);
  const place = `${item.room_id === null ? "" : inWhere(where, dm)}${serverName === null ? "" : ` on ${serverName}`}`;
  const date = DATE.format(item.created_at);
  return {
    face: faceOf(item),
    title,
    who,
    whoName,
    where,
    dm,
    serverName,
    date,
    moment: fullTime(item.created_at),
    size: file ? fileSize(Number(file.size_bytes)) : null,
    starrable: file !== null,
    starred,
    opens: item.message_id !== null && where !== undefined,
    label: `${noun}, ${title}, shared by ${whoName}${place}, ${date}${starred ? ", starred" : ""}`,
  };
}

/** What the grid says when it has nothing to show. */
export function mediaEmpty(filtered: boolean): { title: string; line: string } {
  return filtered
    ? { title: "Nothing here matches those filters.", line: "Try another kind, person or range of dates." }
    : { title: "Good things collect here.", line: "Photos, files and links from your conversations will appear here." };
}

/**
 * The line above the grid when nothing else needs it: what a star is for.
 * With one server it says how long that server keeps files; `undefined` is a
 * server that hasn't said yet.
 */
export function keepLine(expiryDays: number | null | undefined): string {
  if (expiryDays === undefined) return "Starred files don’t expire.";
  if (expiryDays === null) return "This server keeps files for good.";
  return `Files go after ${expiryText(expiryDays)} here. Starred ones stay.`;
}

/**
 * What a star says while the server is asked, and once it has answered. The
 * star itself lights only after it has taken it, never before. Short, so the
 * line keeps to one line beside Clear filters in a narrow window.
 */
export function starLine(starred: boolean, stage: "asking" | "done"): string {
  if (stage === "asking") return starred ? "Starring…" : "Taking the star off…";
  return starred ? "Starred. It won’t expire." : "Took the star off.";
}
