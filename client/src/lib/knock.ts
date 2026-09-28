/**
 * What a refused knock says (SPEC §4.9, #268).
 *
 * Three knocks an hour per person, and the fourth is a `RATE_LIMITED` refusal
 * carrying `retry_after_ms`: how long until the server takes the next one. The
 * sentence says when that is rather than asking the sender to wait an
 * unknown while, and it claims nothing about the other person. A knock that
 * went is not one they heard, so nothing here says they did.
 */

/** The sentence under Knock when the server refuses one for the hour. */
export function knockLimitLine(retryAfterMs: number | null): string {
  return `Three knocks this hour. You can knock again ${knockAgainIn(retryAfterMs)}.`;
}

/**
 * When the next knock goes, in words. Minutes round up, so the time given is
 * never early: 19 minutes 10 seconds is "in 20 minutes". A minute or less is
 * "in a minute", and the most it can be, an hour, is "in an hour". A refusal
 * with no time (an older or different server) is "later" rather than a guess.
 */
function knockAgainIn(retryAfterMs: number | null): string {
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs)) return "later";
  const minutes = Math.ceil(retryAfterMs / 60_000);
  if (minutes <= 1) return "in a minute";
  if (minutes >= 60) return "in an hour";
  return `in ${minutes} minutes`;
}
