/**
 * Knocking on somebody's door (SPEC §4.9), from their card in any window: the
 * request, and what happened in plain words, in today's client's words.
 */
import type { UserId } from "../../generated/UserId";
import { ApiError, TransportError } from "../../lib/api";

/** How a knock went, for the button's words. */
export type KnockResult = { ok: true } | { ok: false; problem: string };

/** The one call a knock needs, so tests can hand in a fake. */
export interface Knocker {
  knock(userId: UserId): Promise<unknown>;
}

export async function knockOn(api: Knocker, userId: UserId): Promise<KnockResult> {
  try {
    await api.knock(userId);
    return { ok: true };
  } catch (error: unknown) {
    const problem =
      error instanceof ApiError && error.code === "RATE_LIMITED"
        ? "That's three this hour. Give them a bit."
        : error instanceof ApiError || error instanceof TransportError
          ? error.message
          : "Couldn't knock.";
    return { ok: false, problem };
  }
}
