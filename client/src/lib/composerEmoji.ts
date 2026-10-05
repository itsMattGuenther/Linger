/**
 * Putting text in the message box at the caret: an emoji from the picker
 * (#359, `lib/emoji`), or a paste the engine couldn't finish.
 */

/** Put a glyph at the caret. Refuse rather than silently truncate. */
export function insertGlyph(
  text: string,
  glyph: string,
  start: number,
  end: number,
  max: number,
): { text: string; caret: number } | null {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const next = text.slice(0, from) + glyph + text.slice(to);
  if (next.length > max) return null;
  return { text: next, caret: from + glyph.length };
}
