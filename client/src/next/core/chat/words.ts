/**
 * Small pieces of wording the chat window builds sentences from. Pure, so
 * the words are tested rather than eyeballed.
 */
import { plainText } from "../../../lib/markdown";

/** A part of a joined list: one of the things, or the words between them. */
export type ListPart<T> = { item: T } | { text: string };

/**
 * "A", "A and B", "A, B and C". Past `max`, the first `max` and "and others":
 * a list of names never turns into a number (AGENTS rule 3 is about counts
 * of what's unread, but a person is not a tally either).
 */
export function joinList<T>(items: readonly T[], max = 3): ListPart<T>[] {
  const shown = items.slice(0, max);
  const more = items.length > max;
  const parts: ListPart<T>[] = [];
  shown.forEach((item, index) => {
    if (index > 0) {
      const last = index === shown.length - 1 && !more;
      parts.push({ text: last ? " and " : ", " });
    }
    parts.push({ item });
  });
  if (more) parts.push({ text: " and others" });
  return parts;
}

/** "is" or "are", for however many people the sentence names. */
export function verbFor(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** A quoted message's first words: markdown flattened, trailing off. */
export function excerpt(body: string, limit = 140): string {
  const text = plainText(body).replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}
