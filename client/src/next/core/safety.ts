/**
 * Report and block on a person's card (SPEC §4.15, PROTOCOL §5, T-1605):
 * what the card needs to offer them, worked out the same way wherever the
 * card opens (the list, a conversation).
 */
import type { GatewayState } from "../../lib/gateway";
import { canTakeOut, sendReport, setBlocked, setCohost } from "../../lib/gateway";
import { ApiError, type AuthedApi, TransportError } from "../../lib/api";
import { mayActOn } from "../../lib/host";
import type { User } from "../../generated/User";

export interface CardSafety {
  /** You've blocked them. */
  blocked: boolean;
  /**
   * Who a report goes to, by name; null when you're the host yourself, who
   * has nobody to send one to and already has delete and remove.
   */
  host: string | null;
  /** A report reaches co-hosts too, besides you (#424), so the form says so. */
  cohosts: boolean;
  /** Block or unblock them: null once the server took it, or what went wrong in words. */
  block: (on: boolean) => Promise<string | null>;
  /** Report them to the host, with a note or none. */
  report: (note: string | null) => Promise<string | null>;
  /**
   * Take them out of the room's voice they're in, as the host or a co-host
   * (#423, #424): the room's name, and the request. Left out unless you can
   * and they're in a room's voice, and for a co-host, on the host's card.
   */
  takeOut?: { room: string; act: () => Promise<string | null> };
  /**
   * Make them a co-host or stop it (#424): only for the host, on somebody
   * else's card. Left out for everybody else, co-hosts included.
   */
  cohost?: {
    /** They're a co-host now. */
    on: boolean;
    /** Turn it on or off: null once the server took it, or what went wrong in words. */
    set: (on: boolean) => Promise<string | null>;
  };
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

/**
 * Whether a report reaches co-hosts as well as the host (#424): somebody
 * other than you is a co-host. You being one doesn't count, since you know
 * what you sent. The host stays the one named.
 */
export function reportsReachCohosts(state: Pick<GatewayState, "me" | "users">): boolean {
  return state.users.some((user) => user.is_cohost === true && user.is_host !== true && user.id !== state.me?.id);
}

/** Report and block for somebody's card, and for the host, co-host; nothing on your own. */
export function cardSafety(api: AuthedApi, state: GatewayState, user: User): CardSafety | undefined {
  if (state.me === null || state.me.id === user.id) return undefined;
  // The room whose voice they're in: rooms only, since a DM's call isn't a
  // place the host reaches into, and the first in list order for somebody
  // in two on two computers. A co-host can't take the host out (#424).
  const voiceRoom =
    canTakeOut(state) && mayActOn(state.me, user)
      ? [...state.rooms]
          .sort((a, b) => a.position - b.position)
          .find((room) => room.archived_at === null && (state.voice[room.id] ?? []).some((peer) => peer.user_id === user.id))
      : undefined;
  const on = user.is_cohost === true;
  return {
    blocked: state.blocked.includes(user.id),
    host: hostName(state),
    cohosts: reportsReachCohosts(state),
    block: (on) => said(setBlocked(api, user.id, on), on ? `Couldn't block ${user.display_name}.` : `Couldn't unblock ${user.display_name}.`),
    report: (note) => said(sendReport(api, note === null ? { user_id: user.id } : { user_id: user.id, note }), "Couldn't send the report."),
    ...(voiceRoom
      ? {
          takeOut: {
            room: voiceRoom.name,
            act: () => said(api.takeOutOfVoice(voiceRoom.id, user.id), `Couldn't take ${user.display_name} out of voice.`),
          },
        }
      : {}),
    // Only the host names co-hosts, and the host is never one (#424).
    cohost:
      state.me.is_host === true && user.is_host !== true
        ? { on, set: (wanted) => said(setCohost(api, user.id, wanted), wanted ? `Couldn't make ${user.display_name} a co-host.` : `Couldn't change that for ${user.display_name}.`) }
        : undefined,
  };
}
