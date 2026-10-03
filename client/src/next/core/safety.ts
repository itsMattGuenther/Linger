/**
 * Report and block on a person's card (SPEC §4.15, PROTOCOL §5, T-1605):
 * what the card needs to offer them, worked out the same way wherever the
 * card opens (the list, a conversation).
 */
import type { GatewayState } from "../../lib/gateway";
import { sendReport, setBlocked } from "../../lib/gateway";
import { ApiError, type AuthedApi, TransportError } from "../../lib/api";
import type { User } from "../../generated/User";

export interface CardSafety {
  /** You've blocked them. */
  blocked: boolean;
  /**
   * Who a report goes to, by name; null when you're the host yourself, who
   * has nobody to send one to and already has delete and remove.
   */
  host: string | null;
  /** Block or unblock them: null once the server took it, or what went wrong in words. */
  block: (on: boolean) => Promise<string | null>;
  /** Report them to the host, with a note or none. */
  report: (note: string | null) => Promise<string | null>;
}

/** A request's failure as a sentence for the person. */
export function inWords(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof TransportError ? error.message : fallback;
}

/** Run a request and say how it went: null, or the problem in words. */
export async function said(work: Promise<unknown>, fallback: string): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error: unknown) {
    return inWords(error, fallback);
  }
}

/** The host's name as the card says it, or null when that's you. */
export function hostName(state: Pick<GatewayState, "me" | "users">): string | null {
  if (state.me?.is_host === true) return null;
  return state.users.find((user) => user.is_host)?.display_name ?? "the host";
}

/** Report and block for somebody's card; nothing on your own. */
export function cardSafety(api: AuthedApi, state: GatewayState, user: User): CardSafety | undefined {
  if (state.me === null || state.me.id === user.id) return undefined;
  return {
    blocked: state.blocked.includes(user.id),
    host: hostName(state),
    block: (on) => said(setBlocked(api, user.id, on), on ? `Couldn't block ${user.display_name}.` : `Couldn't unblock ${user.display_name}.`),
    report: (note) => said(sendReport(api, note === null ? { user_id: user.id } : { user_id: user.id, note }), "Couldn't send the report."),
  };
}
