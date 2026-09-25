/**
 * A status, as data: what is in one, what an empty one looks like, and how the
 * editor's boxes of text become the object that goes over the wire.
 *
 * SPEC §4.6. A status is a small card, not a bio field: one line of free text
 * in the person's own styling, up to three labeled short fields, an optional
 * image, and an away message that supersedes the line when it is set.
 *
 * All of it is pure and lives here rather than in the form, for the usual
 * reason: the rules about trimming, blanks and "has anything actually changed"
 * are the part that is easy to get subtly wrong, and this way they can be
 * tested instead of clicked at.
 */
import type { User } from "../generated/User";
import type { UserStatus } from "../generated/UserStatus";

/**
 * `linger-core::limits::MAX_STATUS_LINE_CHARS` and `MAX_STATUS_FIELD_CHARS`.
 * The server is the authority and refuses anything longer; these copies exist
 * so the editor can count down before the round trip rather than after it,
 * the same way `Stream.tsx` mirrors `MAX_MESSAGE_CHARS`.
 */
export const MAX_LINE_CHARS = 240;
export const MAX_FIELD_CHARS = 80;

/**
 * `linger-core::limits::MAX_STATUS_IMAGE_BYTES` (SPEC §4.6). Same arrangement,
 * with more riding on it: this one is checked before the upload starts, so a
 * file that is never going to be accepted is never sent.
 */
export const MAX_IMAGE_BYTES = 512 * 1024;

/**
 * The image on a status, as the editor holds it: what the server is told, and
 * where to draw it from.
 *
 * Two fields because they are two different things. The id is the client's to
 * set — it names an upload. The URL is the server's answer, built from the
 * object key it stores, and there is no way to work one out from the other on
 * this side (PROTOCOL §6: object URLs are opaque).
 */
export interface StatusImage {
  id: string;
  url: string;
}

/** The editor's boxes. Strings, because that is what an input holds. */
export interface StatusDraft {
  line: string;
  reading: string;
  listening: string;
  workingOn: string;
  awayMessage: string;
  image: StatusImage | null;
}

export const BLANK_DRAFT: StatusDraft = {
  line: "",
  reading: "",
  listening: "",
  workingOn: "",
  awayMessage: "",
  image: null,
};

/**
 * The fields the editor draws, in the order it draws them, with the labels
 * SPEC §4.6 names. One list, so the form and its character counters cannot
 * disagree about what exists.
 */
export const FIELDS: readonly {
  key: "reading" | "listening" | "workingOn";
  label: string;
}[] = [
  { key: "reading", label: "reading" },
  { key: "listening", label: "listening to" },
  { key: "workingOn", label: "working on" },
];

/** Fill the editor from what the server currently holds. */
export function draftOf(status: UserStatus | null | undefined): StatusDraft {
  if (!status) return BLANK_DRAFT;
  return {
    line: status.line ?? "",
    reading: status.reading ?? "",
    listening: status.listening ?? "",
    workingOn: status.working_on ?? "",
    awayMessage: status.away_message ?? "",
    image: imageOf(status),
  };
}

/** The image a saved status is wearing, or null. Both halves or neither. */
export function imageOf(status: UserStatus | null | undefined): StatusImage | null {
  if (!status || status.image_id === null || status.image_url === null) return null;
  return { id: status.image_id, url: status.image_url };
}

/** An empty box means "not set", not "set to nothing". */
function trimmed(value: string): string | null {
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * The object to send.
 *
 * `PATCH /me` replaces the whole status object (PROTOCOL §5), so a field left
 * out of this is a field deleted. The image is the one that costs something:
 * the draft carries whatever the saved status had, and a save that did not
 * touch it sends it back unchanged. The editor is the only thing allowed to
 * change it, and `status.test.ts` pins that.
 *
 * `image_url` and `away_since` are both server-owned — the URL is built from
 * the key the server stores, and `away_since` is stamped when an away message
 * appears or changes — so whatever is sent for either is ignored. They are
 * carried over anyway so the values never round-trip as a lie.
 */
export function statusOf(draft: StatusDraft, previous: UserStatus | null | undefined): UserStatus {
  return {
    line: trimmed(draft.line),
    reading: trimmed(draft.reading),
    listening: trimmed(draft.listening),
    working_on: trimmed(draft.workingOn),
    image_id: draft.image?.id ?? null,
    image_url: draft.image?.url ?? null,
    away_message: trimmed(draft.awayMessage),
    away_since: previous?.away_since ?? null,
  };
}

/** Nothing set. A card with one of these has nothing to open. */
export function isBlank(status: UserStatus | null | undefined): boolean {
  if (!status) return true;
  return (
    status.line === null &&
    status.reading === null &&
    status.listening === null &&
    status.working_on === null &&
    status.image_id === null &&
    status.away_message === null
  );
}

/**
 * Whether saving this draft would change anything the server holds.
 *
 * Compares the fields a person can edit and nothing else, so the reformatting
 * the server does — stamping `away_since`, building `image_url` — never reads
 * as an unsaved change and never leaves the save button lit for no reason.
 */
export function isDirty(draft: StatusDraft, previous: UserStatus | null | undefined): boolean {
  const next = statusOf(draft, previous);
  const now = previous ?? null;
  return (
    next.line !== (now?.line ?? null) ||
    next.reading !== (now?.reading ?? null) ||
    next.listening !== (now?.listening ?? null) ||
    next.working_on !== (now?.working_on ?? null) ||
    next.image_id !== (now?.image_id ?? null) ||
    next.away_message !== (now?.away_message ?? null)
  );
}

/**
 * Whether this file can be a status image, and what to say if it cannot.
 *
 * Asked before the upload starts, not after: the server refuses the same two
 * things, but finding out afterwards means having waited for a file that was
 * never going to be taken. Sizes are said in KB because that is the unit the
 * limit is written in and the one a person's file manager shows.
 */
export function imageProblem(file: File): string | null {
  if (!file.type.startsWith("image/")) return "A status image has to be an image.";
  if (file.size > MAX_IMAGE_BYTES) {
    const kb = Math.round(file.size / 1024);
    return `Status images are up to ${MAX_IMAGE_BYTES / 1024} KB, and that one is ${kb} KB.`;
  }
  return null;
}

/**
 * Whether the editor is holding something the server would refuse.
 *
 * Returns the message to show, or null. The server validates all of this and
 * is the authority (AGENTS rule 8's habit, applied to lengths); this exists so
 * the person finds out while typing rather than on save.
 */
export function overLimit(draft: StatusDraft): string | null {
  const count = (value: string): number => [...value.trim()].length;
  if (count(draft.line) > MAX_LINE_CHARS) return `The line is capped at ${MAX_LINE_CHARS}.`;
  if (count(draft.awayMessage) > MAX_LINE_CHARS) {
    return `The away message is capped at ${MAX_LINE_CHARS}.`;
  }
  for (const field of FIELDS) {
    if (count(draft[field.key]) > MAX_FIELD_CHARS) {
      return `“${field.label}” is capped at ${MAX_FIELD_CHARS}.`;
    }
  }
  return null;
}

/**
 * The away message a person is currently wearing, or null.
 *
 * One place decides this, because three surfaces ask: the roster card, the
 * popover, and the editor's own "you are away" line. Presence carries the live
 * one and the status carries the one that outlives the session — this reads
 * the saved copy, which is the one that is true between connections.
 */
export function awayMessageOf(user: User | null | undefined): string | null {
  const message = user?.status?.away_message ?? null;
  return message === "" ? null : message;
}
