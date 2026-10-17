/**
 * What to call somebody the app has no card for (#650, SPEC §4.19).
 *
 * Two kinds of people are missing from a server's `users`. Somebody the host
 * removed keeps their account, so the host can let them back in, and what they
 * wrote has always said "someone". A deleted account is gone for good, and
 * what it left says "Deleted account": the person chose to go, and the people
 * still talking can tell why a name is missing. Neither gets a name, a color,
 * a status or a card.
 *
 * `gone` is the server's `deletedUsers`, as a set.
 */
export const DELETED_ACCOUNT = "Deleted account";

/** The words for a person who isn't in `users`. */
export function nameless(id: string, gone: ReadonlySet<string> | undefined, otherwise = "someone"): string {
  return gone?.has(id) === true ? DELETED_ACCOUNT : otherwise;
}
