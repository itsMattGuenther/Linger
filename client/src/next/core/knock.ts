/**
 * Knocking on somebody's door (SPEC §4.9), from their card in any window: the
 * request, and what happened in plain words.
 */
import type { UserId } from "../../generated/UserId";
import { ApiError, TransportError } from "../../lib/api";
import { knockLimitLine } from "../../lib/knock";

/** How a knock went, for the button's words. */
export type KnockResult = { ok: true } | { ok: false; problem: string };

/** The one call a knock needs, so tests can hand in a fake. */
export interface Knocker {
  knock(userId: UserId): Promise<unknown>;
}

/**
 * Why Knock can't be pressed for somebody who's offline (#288), in their
 * name. The control stays, greyed out, and says this, rather than going
 * quiet or disappearing: a knock is a sound and a card on their screen
 * (SPEC §4.9), and nobody offline has Linger open to show it.
 */
export function knockOfflineLine(name: string): string {
  return `Can't knock while ${name} is offline.`;
}

/**
 * A note's sentences, so a line breaks between them rather than inside a
 * short one: "Three knocks this hour." over "You can knock again in 20
 * minutes." (#268), not "…knock again in" over "20 minutes.". The card and a
 * narrow DM header are too narrow for both on one line.
 */
export function sentencesOf(text: string): string[] {
  return text.replace(/([.!?]) +/g, "$1\n").split("\n");
}

export async function knockOn(api: Knocker, userId: UserId): Promise<KnockResult> {
  try {
    await api.knock(userId);
    return { ok: true };
  } catch (error: unknown) {
    const problem =
      error instanceof ApiError && error.code === "RATE_LIMITED"
        ? knockLimitLine(error.retryAfterMs)
        : error instanceof ApiError || error instanceof TransportError
          ? error.message
          : "Couldn't knock.";
    return { ok: false, problem };
  }
}
