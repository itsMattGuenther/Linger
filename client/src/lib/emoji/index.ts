/**
 * Every emoji Unicode has (#359), for the picker and the `:shortcode:` list.
 * The list (`data.ts`, made by `scripts/emoji-data.mjs` from Emojibase) is
 * about 200 KB, so it loads the first time something asks for it, not with
 * the app: opening the picker, typing a `:`, or a message that names one.
 *
 * Emoji are drawn by the computer's own emoji font (SPEC §4.8). What that
 * font can't draw is left out of the picker and the list (`support.ts`), so
 * nobody picks an empty box.
 */

/** One emoji, as the picker shows it and a shortcode finds it. */
export interface UnicodeEmoji {
  glyph: string;
  /** Unicode's name for it: "grinning face with big eyes". */
  label: string;
  /** Which of `GROUPS` it's in. */
  group: number;
  /** Discord's names first (`smiley`), then GitHub's and Slack's. Never empty. */
  shortcodes: readonly string[];
  /** Words it's found by: "happy", "yay". */
  tags: readonly string[];
  /** The Unicode emoji version it came in. */
  version: number;
  /** The five skin tones, light to dark, for an emoji that has them. */
  skins?: readonly string[];
}

/** A section of the picker. */
export interface EmojiGroup {
  id: number;
  label: string;
  /** What its tab shows. */
  glyph: string;
}

/** The flags' group, which search puts last among equals. */
const FLAGS = 9;

/** Unicode's groups, in its order. Group 2 (bare skin tones, hair) is left out. */
export const GROUPS: readonly EmojiGroup[] = [
  { id: 0, label: "Smileys & emotion", glyph: "😀" },
  { id: 1, label: "People & body", glyph: "👋" },
  { id: 3, label: "Animals & nature", glyph: "🐻" },
  { id: 4, label: "Food & drink", glyph: "🍔" },
  { id: 5, label: "Travel & places", glyph: "✈️" },
  { id: 6, label: "Activities", glyph: "⚽" },
  { id: 7, label: "Objects", glyph: "💡" },
  { id: 8, label: "Symbols", glyph: "🔣" },
  { id: 9, label: "Flags", glyph: "🏁" },
];

export interface EmojiIndex {
  /** Every emoji, in Unicode's order. */
  all: readonly UnicodeEmoji[];
  /** Any of an emoji's shortcodes, to it. */
  byShortcode: ReadonlyMap<string, UnicodeEmoji>;
  /** A glyph, any skin tone, to its emoji. */
  byGlyph: ReadonlyMap<string, UnicodeEmoji>;
}

export type EmojiRow = [string, string, number, string[], string[], number, string[]?];

/** The list as `data.ts` holds it, made into an index. */
export function indexOf(rows: readonly EmojiRow[]): EmojiIndex {
  const all: UnicodeEmoji[] = rows.map(([glyph, label, group, shortcodes, tags, version, skins]) => ({
    glyph,
    label,
    group,
    shortcodes,
    tags,
    version,
    ...(skins ? { skins } : {}),
  }));
  const byShortcode = new Map<string, UnicodeEmoji>();
  const byGlyph = new Map<string, UnicodeEmoji>();
  for (const emoji of all) {
    for (const code of emoji.shortcodes) if (!byShortcode.has(code)) byShortcode.set(code, emoji);
    byGlyph.set(emoji.glyph, emoji);
    // Without its emoji-style mark, as people often type it: ❤ and ❤️.
    byGlyph.set(emoji.glyph.replace(/️/g, ""), emoji);
    for (const skin of emoji.skins ?? []) byGlyph.set(skin, emoji);
  }
  return { all, byShortcode, byGlyph };
}

let loaded: EmojiIndex | null = null;
let loading: Promise<EmojiIndex> | null = null;
const listeners = new Set<() => void>();

/** The list, loading it the first time. */
export function loadEmoji(): Promise<EmojiIndex> {
  loading ??= import("./data").then((module) => {
    loaded = indexOf(module.default);
    for (const listener of listeners) listener();
    return loaded;
  });
  return loading;
}

/** The list if it's loaded, or null. */
export function emojiIndex(): EmojiIndex | null {
  return loaded;
}

/** Told once, when the list has loaded. */
export function onEmojiLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A tone of 0 is the emoji's own yellow; 1 to 5 are light to dark. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

/** The emoji in `tone`, if it comes in tones. */
export function withTone(emoji: UnicodeEmoji, tone: SkinTone): string {
  return tone === 0 ? emoji.glyph : (emoji.skins?.[tone - 1] ?? emoji.glyph);
}

/**
 * Emoji for what's typed, best first: a shortcode that is the query, then
 * shortcodes that start with it, then names and words that start with it,
 * then shortcodes that hold it. "smi" finds :smile: before :smirk_cat:,
 * "hello" finds 👋 by its words.
 */
export function searchEmoji(emoji: readonly UnicodeEmoji[], query: string, limit = Number.POSITIVE_INFINITY): UnicodeEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (q === "") return [];
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9+-]+/);
  const scored: { emoji: UnicodeEmoji; score: number; length: number; at: number }[] = [];
  emoji.forEach((one, at) => {
    let score = 0;
    for (const code of one.shortcodes) {
      // A flag's two letters (`:sm:` is San Marino) match short typing by
      // accident: they don't come first for it.
      if (code === q) score = Math.max(score, one.group === FLAGS && code.length === 2 ? 3 : 5);
      else if (code.startsWith(q)) score = Math.max(score, 4);
      else if (code.split("_").some((part) => part.startsWith(q))) score = Math.max(score, 3);
      else if (code.includes(q)) score = Math.max(score, 1);
    }
    if (score < 3 && words(one.label).some((word) => word.startsWith(q))) score = Math.max(score, 3);
    if (score < 2 && one.tags.some((tag) => tag.startsWith(q))) score = 2;
    if (score > 0) {
      // Among equals the shortest name first: `:smi` is :smile:, then :smiley:.
      const length = Math.min(...one.shortcodes.filter((code) => code.includes(q)).map((code) => code.length), Number.POSITIVE_INFINITY);
      scored.push({ emoji: one, score, length, at });
    }
  });
  scored.sort(
    (a, b) => b.score - a.score || Number(a.emoji.group === FLAGS) - Number(b.emoji.group === FLAGS) || a.length - b.length || a.at - b.at,
  );
  return scored.slice(0, limit).map((found) => found.emoji);
}

/**
 * The text to show for an emoji someone typed by its shortcode: Discord's
 * own name, so the list and the picker always call it the same thing.
 */
export function shortcodeOf(emoji: UnicodeEmoji): string {
  return emoji.shortcodes[0] ?? emoji.label;
}
