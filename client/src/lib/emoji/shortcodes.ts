/**
 * Emoji by name in the message box (#359): `:smi` offers emoji, and a
 * finished `:smiley:` becomes 😃 as it's typed. Pure; the composer draws it.
 *
 * A Unicode emoji goes into the message as itself. A server's own emoji goes
 * in as its `:name:`, which every app on that server draws as the picture,
 * and which search, export and a removed emoji read as the name.
 */

/** What a shortcode can hold between its colons: `+1`, `thumbsup`, `party_parrot`. */
const NAME = /^[a-z0-9_+-]$/;

/** A shortcode being typed: the `:` and what's typed after it up to the caret. */
export interface ShortcodeTyping {
  /** Where the `:` is. */
  start: number;
  /** The end of the word it starts, which choosing an emoji replaces. */
  end: number;
  /** What's typed after the `:`, lowercased: "smi". */
  query: string;
}

/** How much has to be typed after a `:` before emoji are offered, as Discord does. */
export const SHORTCODE_MIN = 2;

/**
 * Whether a `:` at `at` can start a shortcode, by the message parser's own
 * rule (`lib/markdown.ts`): not straight after a letter or a digit, so
 * `12:30`, `http://` and `a:b` never offer emoji, and straight after another
 * `:name:` (`:a::b:`) or an emoji.
 */
export function shortcodeCanStart(text: string, at: number): boolean {
  if (text[at] !== ":") return false;
  if (at === 0) return true;
  const before = text[at - 1] ?? "";
  if (before === ":") return /:[a-z0-9_+-]+:$/i.test(text.slice(0, at));
  return !/[\p{L}\p{N}_]/u.test(before);
}

/** The shortcode being typed at the caret, or null. */
export function shortcodeAt(text: string, caret: number): ShortcodeTyping | null {
  if (caret < 1 || caret > text.length) return null;
  let at = caret;
  while (at > 0 && NAME.test((text[at - 1] ?? "").toLowerCase())) at -= 1;
  const start = at - 1;
  if (start < 0 || !shortcodeCanStart(text, start)) return null;
  const query = text.slice(at, caret).toLowerCase();
  if (query.length < SHORTCODE_MIN) return null;
  let end = caret;
  while (end < text.length && NAME.test((text[end] ?? "").toLowerCase())) end += 1;
  return { start, end, query };
}

/** Two readings of the box that would draw the same list. */
export function sameShortcode(a: ShortcodeTyping | null, b: ShortcodeTyping | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end && a.query === b.query);
}

/**
 * A `:name:` just finished at the caret, turned into its emoji: the box's new
 * text and where the caret goes. Null when what was just closed isn't a
 * shortcode `glyphOf` knows: a server's own emoji stay as their `:name:`.
 */
export function completeShortcode(text: string, caret: number, glyphOf: (name: string) => string | null): { text: string; caret: number } | null {
  if (text[caret - 1] !== ":") return null;
  let at = caret - 1;
  while (at > 0 && NAME.test(text[at - 1] ?? "")) at -= 1;
  const start = at - 1;
  if (start < 0 || caret - 1 - at < 1 || !shortcodeCanStart(text, start)) return null;
  const glyph = glyphOf(text.slice(at, caret - 1));
  if (glyph === null) return null;
  return { text: text.slice(0, start) + glyph + text.slice(caret), caret: start + glyph.length };
}

/**
 * The box with `insert` where the shortcode being typed was, and a space
 * after it unless one is there: what choosing from the list does. Null when
 * the message would be too long.
 */
export function putShortcode(text: string, typing: ShortcodeTyping, insert: string, max: number): { text: string; caret: number } | null {
  const rest = text.slice(typing.end);
  const spaced = rest.startsWith(" ") ? insert : `${insert} `;
  const next = text.slice(0, typing.start) + spaced + rest;
  if (next.length > max) return null;
  return { text: next, caret: typing.start + spaced.length };
}

/**
 * Every finished `:name:` in `text` that `glyphOf` knows, turned into its
 * emoji, outside code: what typing them does, for shortcodes finished before
 * the emoji list had loaded. `caret` moves with the text before it.
 */
export function convertShortcodes(text: string, caret: number, glyphOf: (name: string) => string | null): { text: string; caret: number } {
  let out = "";
  let moved = caret;
  // Where each part starts in `text`, which `caret` is measured in.
  let offset = 0;
  // Code, inline or fenced, is left as typed.
  for (const part of text.split(/(```[\s\S]*?```|`[^`\n]*`)/)) {
    if (part.startsWith("`")) {
      out += part;
      offset += part.length;
      continue;
    }
    let at = 0;
    for (const found of part.matchAll(/:([a-z0-9_+-]+):/g)) {
      const start = found.index;
      if (start < at || !shortcodeCanStart(text, offset + start)) continue;
      const glyph = glyphOf(found[1] ?? "");
      if (glyph === null) continue;
      out += part.slice(at, start) + glyph;
      const from = offset + start;
      const to = from + found[0].length;
      // After it, the caret moves back by what got shorter; inside it, to its end.
      if (caret >= to) moved -= found[0].length - glyph.length;
      else if (caret > from) moved = out.length;
      at = start + found[0].length;
    }
    out += part.slice(at);
    offset += part.length;
  }
  return { text: out, caret: Math.max(0, moved) };
}
