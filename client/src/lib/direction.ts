/**
 * The characters that change the direction of text (#296, #488): the
 * embeddings and overrides (U+202A–U+202E) and isolates (U+2066–U+2069),
 * which turn the text after them around, and the three direction marks
 * (U+200E, U+200F, U+061C), which move the punctuation and numbers beside
 * them. A copy of `validate::changes_direction` on the server, which says why
 * each is there.
 *
 * A display name that holds one is refused. A file's name, a status, a room's
 * name and topic, its message of the day and a poll lose them on the way in.
 */
export const CHANGES_DIRECTION = /[\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

const EVERY_ONE = new RegExp(CHANGES_DIRECTION.source, "gu");

/** The text without them. Letters in any script keep their own direction. */
export function withoutDirectionControls(text: string): string {
  return text.replace(EVERY_ONE, "");
}
