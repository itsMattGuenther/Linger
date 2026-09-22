/**
 * The twelve reactions, and how a pile of them is drawn.
 *
 * SPEC §4.8: a fixed palette of twelve, no custom emoji and no picker. The keys
 * are the server's — `linger-core::REACTIONS` — and the server rejects anything
 * that is not one of them. The glyph and the wording for each are the client's
 * business, which is why they live here and not on the wire.
 *
 * **Reactions accumulate by weight, never by number.** Six people hitting the
 * same reaction make a bigger, denser mark, not `👍 6`. The count exists on the
 * wire only to set that weight. Hover and keyboard focus name the people who
 * reacted, without turning their reaction into a score.
 */

export interface Reaction {
  /** The wire key. Must match `linger-core::REACTIONS`. */
  key: string;
  glyph: string;
  /** What it is called out loud, for the accessible label. */
  label: string;
}

/**
 * In the server's order, so the row of choices and the marks on a message
 * always sit in the same places. A key the server sends that is not in this
 * list is skipped rather than guessed at — a newer server can add one and an
 * older client simply does not draw it.
 */
export const REACTIONS: readonly Reaction[] = [
  { key: "heart", glyph: "❤️", label: "heart" },
  { key: "laugh", glyph: "😂", label: "laugh" },
  { key: "wow", glyph: "😮", label: "wow" },
  { key: "cry", glyph: "😢", label: "cry" },
  { key: "fire", glyph: "🔥", label: "fire" },
  { key: "skull", glyph: "💀", label: "skull" },
  { key: "up", glyph: "👍", label: "thumbs up" },
  { key: "down", glyph: "👎", label: "thumbs down" },
  { key: "eyes", glyph: "👀", label: "eyes" },
  { key: "clap", glyph: "👏", label: "clap" },
  { key: "hundred", glyph: "💯", label: "a hundred" },
  { key: "sparkles", glyph: "✨", label: "sparkles" },
];

const BY_KEY = new Map(REACTIONS.map((reaction) => [reaction.key, reaction]));

export function reactionOf(key: string): Reaction | undefined {
  return BY_KEY.get(key);
}

/**
 * How heavy a mark is, from 0 to 1. CSS turns this into size and density; this
 * function decides only the shape of the curve.
 *
 * It is logarithmic on purpose. The step from one person to two is the one that
 * means something — somebody agreed — and the step from nine to ten means
 * almost nothing. A linear ramp would spend all its range on the part nobody
 * cares about and make the interesting difference invisible. Eight reactors
 * reaches full weight, which is more than everyone in the kind of room this is
 * built for.
 */
export function reactionWeight(count: number): number {
  if (count <= 1) return 0;
  return Math.min(1, Math.log2(count) / 3);
}

/**
 * The hover text: who reacted. This is the "hover reveals who" half of SPEC
 * §4.8 and it is the only place the tally is spelled out.
 *
 * Names come in first-reacted order from the server. A server is deliberately
 * small, so the tooltip can name everybody and wrap without substituting a
 * numeric count.
 */
export function reactionTitle(names: readonly string[], label: string): string {
  const who = whoReacted(names);
  return who === null ? label : `${who} — ${label}`;
}

function whoReacted(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return listOf(names);
}

function listOf(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  const last = names[names.length - 1] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${last}`;
}
