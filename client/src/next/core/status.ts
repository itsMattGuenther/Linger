/**
 * Your status as Settings → Profile edits it (SPEC §4.6, #270): the line, up
 * to three fields with labels you choose, and the away message, as the boxes
 * hold them, and how they become the status that is saved.
 *
 * Pure, like `lib/status.ts` beside it, because trimming, blanks, labels and
 * "has anything changed" are the parts that are easy to get subtly wrong.
 * `core/you.ts` builds its quick edits from the list through the same
 * functions, so a quick edit never drops a field.
 */
import type { StatusField } from "../../generated/StatusField";
import type { UserStatus } from "../../generated/UserStatus";
import { classicOf, fieldsOf, MAX_FIELD_CHARS, MAX_FIELDS, MAX_LABEL_CHARS, MAX_LINE_CHARS, SUGGESTED_LABELS } from "../../lib/status";

export type SuggestedLabel = (typeof SUGGESTED_LABELS)[number];

/** The drop-down's last choice, "Your own…", which turns the label into a box to type in. */
export const OWN = "own";
export type LabelChoice = SuggestedLabel | typeof OWN;

/** One field in the editor: the label picked or typed, and what it says. */
export interface FieldRow {
  choice: LabelChoice;
  /** The label typed, used when `choice` is `OWN`. */
  own: string;
  value: string;
}

/** The editor's boxes. Strings, because that is what an input holds; always three rows. */
export interface StatusDraft {
  line: string;
  rows: FieldRow[];
  awayMessage: string;
}

function isSuggested(label: string): label is SuggestedLabel {
  return (SUGGESTED_LABELS as readonly string[]).includes(label);
}

/**
 * Words the server takes: no tabs, line breaks or other control characters
 * (the server refuses them), and no space at either end. A tab pasted into a
 * box becomes a space rather than a refusal.
 */
function clean(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").trim();
}

/** An empty box means "not set", not "set to nothing". */
function orNull(text: string): string | null {
  const words = clean(text);
  return words === "" ? null : words;
}

/** The label a row gives its field, as it will be saved. */
export function labelOf(row: FieldRow): string {
  return clean(row.choice === OWN ? row.own : row.choice);
}

/**
 * Fill the editor from what the server holds: a row for each field, in
 * order, then blank rows on the suggestions no field uses yet, so an empty
 * status starts as Listening to, Reading and Working on.
 */
export function draftOf(status: UserStatus | null | undefined): StatusDraft {
  const fields = fieldsOf(status).slice(0, MAX_FIELDS);
  const rows: FieldRow[] = fields.map((field) =>
    isSuggested(field.label) ? { choice: field.label, own: "", value: field.value } : { choice: OWN, own: field.label, value: field.value },
  );
  const used = new Set(fields.map((field) => field.label));
  for (const label of SUGGESTED_LABELS) {
    if (rows.length >= MAX_FIELDS) break;
    if (!used.has(label)) rows.push({ choice: label, own: "", value: "" });
  }
  return { line: status?.line ?? "", rows, awayMessage: status?.away_message ?? "" };
}

/** The fields a draft saves: each row with both a label and something beside it, in order. */
export function fieldsFrom(draft: StatusDraft): StatusField[] {
  return draft.rows.flatMap((row) => {
    const label = labelOf(row);
    const value = clean(row.value);
    return label !== "" && value !== "" ? [{ label, value }] : [];
  });
}

/**
 * The object to send.
 *
 * `PATCH /me` replaces the whole status (PROTOCOL §5), and `fields` is the
 * whole set. The three fixed keys are filled from the fields with those
 * labels for a server that predates fields; a newer one fills them itself.
 * A status has no picture (#269), and `away_since` is the server's, carried
 * over so it never round-trips as a lie.
 */
export function statusOf(draft: StatusDraft, previous: UserStatus | null | undefined): UserStatus {
  const fields = fieldsFrom(draft);
  return {
    line: orNull(draft.line),
    ...classicOf(fields),
    fields,
    image_id: null,
    image_url: null,
    away_message: orNull(draft.awayMessage),
    away_since: previous?.away_since ?? null,
  };
}

function sameFields(one: readonly StatusField[], other: readonly StatusField[]): boolean {
  return one.length === other.length && one.every((field, at) => field.label === other[at]?.label && field.value === other[at]?.value);
}

/**
 * Whether saving this draft would change anything the server holds. A blank
 * row's label is not a change: nothing is saved for it.
 */
export function isDirty(draft: StatusDraft, previous: UserStatus | null | undefined): boolean {
  const next = statusOf(draft, previous);
  return (
    next.line !== (previous?.line ?? null) ||
    next.away_message !== (previous?.away_message ?? null) ||
    !sameFields(next.fields ?? [], fieldsOf(previous))
  );
}

/**
 * What the server would refuse in this draft, in words, or null. The server
 * checks all of it and is the authority (AGENTS rule 8's habit); this is so
 * the person finds out while typing rather than on save.
 */
export function problemOf(draft: StatusDraft): string | null {
  const count = (text: string): number => [...clean(text)].length;
  if (count(draft.line) > MAX_LINE_CHARS) return `The line is capped at ${MAX_LINE_CHARS}.`;
  if (count(draft.awayMessage) > MAX_LINE_CHARS) return `The away message is capped at ${MAX_LINE_CHARS}.`;
  const seen = new Set<string>();
  for (const row of draft.rows) {
    const label = labelOf(row);
    const filled = clean(row.value) !== "";
    if (count(label) > MAX_LABEL_CHARS) return `A label is capped at ${MAX_LABEL_CHARS}.`;
    if (count(row.value) > MAX_FIELD_CHARS) return `“${label || "A field"}” is capped at ${MAX_FIELD_CHARS}.`;
    if (!filled) continue;
    if (label === "") return "A field needs a label. Pick one, or type your own.";
    const key = label.toLowerCase();
    if (seen.has(key)) return `Two fields are labelled “${label}”. Give each its own.`;
    seen.add(key);
  }
  return null;
}
