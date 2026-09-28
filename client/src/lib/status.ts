/**
 * A status, as data: what is in one, what an empty one looks like, and how the
 * editor's boxes of text become the object that goes over the wire.
 *
 * SPEC §4.6. A status is a small card, not a bio field: one line of free text
 * in the person's own styling, up to three short fields with labels the
 * person chose (#270), and an away message that supersedes the line when it is
 * set. It has no picture (#269).
 *
 * All of it is pure and lives here rather than in the form, for the usual
 * reason: the rules about trimming, blanks and "has anything actually changed"
 * are the part that is easy to get subtly wrong, and this way they can be
 * tested instead of clicked at.
 */
import type { StatusField } from "../generated/StatusField";
import type { UserStatus } from "../generated/UserStatus";

/**
 * `linger-core::limits::MAX_STATUS_LINE_CHARS`, `MAX_STATUS_FIELD_CHARS`,
 * `MAX_STATUS_LABEL_CHARS` and `MAX_STATUS_FIELDS`. The server is the
 * authority and refuses anything longer; these copies exist so the editor can
 * count down before the round trip rather than after it, the same way
 * `EditBox.tsx` mirrors `MAX_MESSAGE_CHARS`.
 */
export const MAX_LINE_CHARS = 240;
export const MAX_FIELD_CHARS = 80;
export const MAX_LABEL_CHARS = 24;
export const MAX_FIELDS = 3;

/**
 * The labels a field offers before you type your own (#270), in the order
 * the drop-down lists them.
 */
export const SUGGESTED_LABELS = ["Listening to", "Reading", "Working on", "Playing", "Watching"] as const;

/**
 * The three labels apps from before #270 know, with the key each travels
 * under (`linger-core::wire::STATUS_LABEL_*`), in the order a card shows
 * them. A field whose label is exactly one of these is also sent under its
 * key, so an older server keeps it.
 */
export const CLASSIC_LABELS = [
  ["listening", "Listening to"],
  ["reading", "Reading"],
  ["working_on", "Working on"],
] as const;

type ClassicKey = (typeof CLASSIC_LABELS)[number][0];

/** A status as any server sends it: one from before #270 leaves `fields` out. */
export type AnyStatus = Omit<UserStatus, "fields"> & { fields?: UserStatus["fields"] };

/**
 * A status's fields, in order.
 *
 * A server from #270 on always sends them. An older one sends only the three
 * fixed keys, which become fields with those labels, in the order a card has
 * always shown them.
 */
export function fieldsOf(status: AnyStatus | null | undefined): StatusField[] {
  if (!status) return [];
  if (status.fields) return status.fields;
  return CLASSIC_LABELS.flatMap(([key, label]) => {
    const value = status[key];
    return value !== null && value !== undefined && value.trim() !== "" ? [{ label, value }] : [];
  });
}

/**
 * The three fixed keys, filled from the fields whose labels match exactly,
 * for a server that predates fields. A newer server fills them itself and
 * ignores what is sent beside `fields`.
 */
export function classicOf(fields: readonly StatusField[]): Pick<UserStatus, ClassicKey> {
  const find = (label: string) => fields.find((field) => field.label === label)?.value ?? null;
  return { listening: find("Listening to"), reading: find("Reading"), working_on: find("Working on") };
}
