/**
 * A status, as data: what is in one, what an empty one looks like, and how the
 * editor's boxes of text become the object that goes over the wire.
 *
 * SPEC §4.6. A status is a small card, not a bio field: one line of free text
 * in the person's own styling, up to three labeled short fields, and an away
 * message that supersedes the line when it is set. It has no picture (#269).
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

/** The editor's boxes. Strings, because that is what an input holds. */
export interface StatusDraft {
  line: string;
  reading: string;
  listening: string;
  workingOn: string;
  awayMessage: string;
}

export const BLANK_DRAFT: StatusDraft = {
  line: "",
  reading: "",
  listening: "",
  workingOn: "",
  awayMessage: "",
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
  };
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
 * out of this is a field deleted.
 *
 * A status has no picture (#269): `image_id` and `image_url` are always sent
 * as null, even when an older server still hands one back, so a save never
 * keeps a picture alive. `away_since` is server-owned — stamped when an away
 * message appears or changes — so whatever is sent for it is ignored. It is
 * carried over anyway so the value never round-trips as a lie.
 */
export function statusOf(draft: StatusDraft, previous: UserStatus | null | undefined): UserStatus {
  return {
    line: trimmed(draft.line),
    reading: trimmed(draft.reading),
    listening: trimmed(draft.listening),
    working_on: trimmed(draft.workingOn),
    image_id: null,
    image_url: null,
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
    status.away_message === null
  );
}

/**
 * Whether saving this draft would change anything the server holds.
 *
 * Compares the fields a person can edit and nothing else, so what the server
 * owns — `away_since`, and the image fields that are always null — never reads
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
    next.away_message !== (now?.away_message ?? null)
  );
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
