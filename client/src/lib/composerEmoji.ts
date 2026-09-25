/**
 * Ordinary Unicode for the composer. Emoji go in what you say: there are no
 * reactions during the trial (#168), and no custom emoji (SPEC §4.8).
 */

export interface ComposerEmoji {
  glyph: string;
  label: string;
}

/** A short, familiar set. No custom marks, no skin-tone picker, no search. */
export const COMPOSER_EMOJI: readonly ComposerEmoji[] = [
  { glyph: "😀", label: "grinning" },
  { glyph: "😃", label: "smiling" },
  { glyph: "😄", label: "smile" },
  { glyph: "😁", label: "beaming" },
  { glyph: "😆", label: "laughing" },
  { glyph: "😅", label: "sweating smile" },
  { glyph: "😂", label: "tears of joy" },
  { glyph: "🤣", label: "rolling on the floor" },
  { glyph: "😊", label: "blushing" },
  { glyph: "😇", label: "halo" },
  { glyph: "🙂", label: "slight smile" },
  { glyph: "😉", label: "wink" },
  { glyph: "😍", label: "heart eyes" },
  { glyph: "🥰", label: "smiling hearts" },
  { glyph: "😘", label: "kiss" },
  { glyph: "😜", label: "tongue out" },
  { glyph: "🤔", label: "thinking" },
  { glyph: "😐", label: "neutral" },
  { glyph: "😑", label: "expressionless" },
  { glyph: "😏", label: "smirk" },
  { glyph: "😢", label: "crying" },
  { glyph: "😭", label: "sobbing" },
  { glyph: "😤", label: "frustrated" },
  { glyph: "😡", label: "angry" },
  { glyph: "🤯", label: "exploding head" },
  { glyph: "😱", label: "scream" },
  { glyph: "😴", label: "sleeping" },
  { glyph: "🥳", label: "party" },
  { glyph: "😎", label: "sunglasses" },
  { glyph: "🤓", label: "nerd" },
  { glyph: "👍", label: "thumbs up" },
  { glyph: "👎", label: "thumbs down" },
  { glyph: "👏", label: "clap" },
  { glyph: "🙌", label: "raising hands" },
  { glyph: "🤝", label: "handshake" },
  { glyph: "✌️", label: "peace" },
  { glyph: "🤞", label: "crossed fingers" },
  { glyph: "👋", label: "wave" },
  { glyph: "❤️", label: "heart" },
  { glyph: "🧡", label: "orange heart" },
  { glyph: "💛", label: "yellow heart" },
  { glyph: "💚", label: "green heart" },
  { glyph: "💙", label: "blue heart" },
  { glyph: "💜", label: "purple heart" },
  { glyph: "🖤", label: "black heart" },
  { glyph: "💔", label: "broken heart" },
  { glyph: "✨", label: "sparkles" },
  { glyph: "🔥", label: "fire" },
  { glyph: "⭐", label: "star" },
  { glyph: "💯", label: "hundred" },
  { glyph: "🎉", label: "party popper" },
  { glyph: "✅", label: "check" },
  { glyph: "❌", label: "cross" },
  { glyph: "⚠️", label: "warning" },
  { glyph: "👀", label: "eyes" },
  { glyph: "💀", label: "skull" },
  { glyph: "☕", label: "coffee" },
  { glyph: "🍺", label: "beer" },
  { glyph: "🍕", label: "pizza" },
  { glyph: "☀️", label: "sun" },
  { glyph: "🌙", label: "moon" },
  { glyph: "🌧️", label: "rain" },
  { glyph: "🎵", label: "music" },
  { glyph: "🏠", label: "house" },
];

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
