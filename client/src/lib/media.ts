/**
 * The arithmetic and the words behind the media collection (SPEC §4.4, §5.6).
 *
 * Pure functions only, so the grid and the stream agree about what a file is
 * called, how big it is, and how tall it is allowed to be — and so all of that
 * is testable without a browser.
 */
import type { MediaItem } from "../generated/MediaItem";
import type { MediaKind } from "../generated/MediaKind";

/** An image renders at true aspect ratio, capped at this height (SPEC §5.6). */
export const MAX_INLINE_HEIGHT = 400;

/**
 * Which renderer an attachment gets.
 *
 * A prefix test, not a copy of `linger-core::media` — the server has already
 * decided what it will store and what it will serve inline, and this only picks
 * between an `<img>`, a `<video>`, an `<audio>` and a line of text. A type this
 * does not recognise is a file, which is the safe answer.
 */
export function renderAs(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * A size somebody can read. Two significant-ish digits and the unit — nobody
 * needs to know a photo is 3,417,244 bytes.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The status bar's storage figure (SPEC §5.6): what this server is holding,
 * against what it is allowed to hold.
 *
 * Both halves, not a percentage and not a bar. "8.2 GB / 50 GB" answers the
 * only question anybody actually has — is there room for this video — and a
 * percentage does not, because 4% of an unknown number is nothing.
 */
export function storageLine(usedBytes: number, limitBytes: number): string {
  return `${fileSize(usedBytes)} / ${fileSize(limitBytes)}`;
}

/**
 * The sentence behind that figure, on hover: how full, and what happens to old
 * files here. Expiry is a per-server setting and it deletes people's things, so
 * it should be readable somewhere rather than only true.
 */
export function storageDetail(
  usedBytes: number,
  limitBytes: number,
  expiryDays: number | null,
): string {
  const share = `${fileSize(usedBytes)} of ${fileSize(limitBytes)} used`;
  return expiryDays === null
    ? `${share}. Files are kept for good on this server.`
    : `${share}. Files are removed after ${expiryText(expiryDays)} unless they are starred or on a pinned message.`;
}

/**
 * A year is "a year", not "365 days". Anything that is not a round year or
 * month stays in days, because rounding somebody's 45-day window to "a month
 * and a half" is worse than saying the number.
 */
export function expiryText(days: number): string {
  if (days === 365) return "a year";
  if (days === 1) return "a day";
  if (days % 365 === 0) return `${days / 365} years`;
  if (days === 30) return "a month";
  if (days % 30 === 0) return `${days / 30} months`;
  return `${days} days`;
}

/** `4:07`, or `1:02:30` once it is over an hour. */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * How big to draw an image: its own shape, never taller than the cap, and never
 * wider than the column it is in (CSS handles that half with `max-width`).
 *
 * Returning the box rather than leaving it to CSS is what stops the stream
 * jumping as pictures load — the row is the right height before the bytes
 * arrive, which matters more here than anywhere because the list is virtualized
 * and a row that changes height after measurement moves everything under it.
 */
export function inlineBox(
  width: number | null,
  height: number | null,
  cap = MAX_INLINE_HEIGHT,
): { width: number; height: number } | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  if (height <= cap) return { width, height };
  return { width: Math.round((width * cap) / height), height: cap };
}

/** The filters the grid offers, in the order they are drawn. */
export const KIND_FILTERS: Array<{ key: MediaKind | null; label: string }> = [
  { key: null, label: "everything" },
  { key: "image", label: "images" },
  { key: "video", label: "video" },
  { key: "audio", label: "audio" },
  { key: "file", label: "files" },
  { key: "link", label: "links" },
  { key: "pin", label: "pinned" },
];

/**
 * `<input type="date">` gives back `YYYY-MM-DD` and means it in the reader's own
 * timezone, so a range picked as "the 4th" has to cover the 4th where they are
 * standing — not 00:00 UTC, which is the evening of the 3rd for half the world.
 */
export function dayStart(value: string): number | null {
  const at = parseDay(value);
  return at === null ? null : at.getTime();
}

export function dayEnd(value: string): number | null {
  const at = parseDay(value);
  if (at === null) return null;
  at.setHours(23, 59, 59, 999);
  return at.getTime();
}

function parseDay(value: string): Date | null {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!found) return null;
  const [, year, month, day] = found;
  const at = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** What a tile says under it when the item has no other words of its own. */
export function itemLabel(item: MediaItem): string {
  if (item.attachment) return item.attachment.filename;
  if (item.link) return item.link.title ?? item.link.domain;
  return item.excerpt ?? "a pinned message";
}

/**
 * The accessible name of a tile: what it is, who shared it, and whether it is
 * starred. A screen reader gets the sentence the layout is drawing.
 */
export function itemDescription(item: MediaItem, who: string): string {
  const noun = item.kind === "pin" ? "pinned message" : item.kind;
  const starred = item.starred_at === null ? "" : ", starred";
  return `${noun}, ${itemLabel(item)}, shared by ${who}${starred}`;
}
