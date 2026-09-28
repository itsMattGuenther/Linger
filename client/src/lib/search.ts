/**
 * The words and the arithmetic behind the search surface (SPEC §4.12).
 *
 * Pure functions only, so what a hit *says* can be tested without a browser —
 * the panel is the part you have to look at, and none of the interesting
 * decisions are in the looking.
 *
 * Two of these exist because of the shape the server sends. A snippet arrives
 * cut into runs rather than as a marked-up string (PROTOCOL §6), which is right
 * for drawing and useless for a screen reader, so `snippetText` puts it back
 * together as one line. And a hit can have no words at all — a photo posted
 * with no caption, found by its filename — so the fallback line is not an edge
 * case, it is the whole reason `matched_filenames` is on the wire.
 */
import type { SearchSnippetPart } from "../generated/SearchSnippetPart";

/**
 * `linger-core::limits::MAX_SEARCH_QUERY_CHARS`, mirrored so the box can stop
 * at 200 characters rather than let somebody paste an essay and be refused.
 * The server still checks; this only saves the round trip.
 */
export const MAX_QUERY_CHARS = 200;

/**
 * How long the box waits after the last keystroke before it asks.
 *
 * The rate limit is 30 searches a minute (`RATE_SEARCH`), which is one every
 * two seconds sustained — generous for typing in bursts, and gone in eleven
 * seconds if every keystroke is a request. A third of a second is under what a
 * person notices and above what a typist produces mid-word.
 */
export const TYPING_PAUSE_MS = 320;

/** A page. Small: results are scanned, and the next page is one click away. */
export const PAGE = 25;

/** The snippet as one line of plain text, for a label a screen reader reads. */
export function snippetText(parts: SearchSnippetPart[]): string {
  return parts.map((part) => part.text).join("");
}

/**
 * What the results area says when it has no results to show.
 *
 * Three different silences, and telling them apart is the whole job: nobody has
 * typed yet, what they typed was not searchable, or it was searched for and is
 * not here. The third one is the only one that means "try another word".
 */
export function emptyLine(typed: string, filtered: boolean): string {
  if (typed.trim() === "") {
    return "Search what people have said here, and the names of the files they shared.";
  }
  if (!isSearchable(typed)) return "Type a word to search for.";
  return filtered
    ? "Nothing matches that in the room or from the person you picked."
    : "Nothing here matches that.";
}

/**
 * Whether there is anything in the box the index could match.
 *
 * The server's own answer to this is `Terms::parse`, and a query of pure
 * punctuation is a validation refusal there. This is not a copy of that
 * parser — it is the one thing they agree on, "some letter or digit somewhere"
 * — and it exists so the box does not spend a rate-limit token to be told off
 * for a lone question mark.
 */
export function isSearchable(typed: string): boolean {
  return [...typed].some((c) => /\p{L}|\p{N}/u.test(c));
}
