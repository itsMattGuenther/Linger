/**
 * A server's own emoji's name (#359): what's written between the colons.
 * `linger-core::limits::emoji_name_ok` is the rule, which the server holds
 * every name to; this mirrors it so the app can say so before asking.
 */

/** `EMOJI_NAME_MIN_CHARS` and `EMOJI_NAME_MAX_CHARS`. */
export const EMOJI_NAME_MIN = 2;
export const EMOJI_NAME_MAX = 32;
/** `MAX_CUSTOM_EMOJI`: how many a server holds. */
export const MAX_CUSTOM_EMOJI = 200;
/** `MAX_EMOJI_BYTES`. */
export const MAX_EMOJI_BYTES = 256 * 1024;

/** Lowercase letters, digits and underscores, 2 to 32 of them. */
export function emojiNameOk(name: string): boolean {
  return name.length >= EMOJI_NAME_MIN && name.length <= EMOJI_NAME_MAX && /^[a-z0-9_]+$/.test(name);
}

/** What the rule asks for, said when a name breaks it. */
export const EMOJI_NAME_RULE = "A name is 2 to 32 lowercase letters, digits or underscores.";

/**
 * A name from a picture's file name, so adding an emoji needs no typing:
 * `Party Parrot (1).gif` is `party_parrot_1`. One already taken gets a
 * number: `party_parrot_2`.
 */
export function emojiNameFrom(filename: string, taken: ReadonlySet<string>): string {
  const base =
    filename
      .replace(/\.[a-z0-9]+$/i, "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, EMOJI_NAME_MAX) || "emoji";
  const name = base.length >= EMOJI_NAME_MIN ? base : `${base}_emoji`;
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const next = name.slice(0, EMOJI_NAME_MAX - suffix.length) + suffix;
    if (!taken.has(next)) return next;
  }
}
