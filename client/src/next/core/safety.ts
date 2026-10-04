/**
 * Report and block on a person's card (SPEC §4.15, PROTOCOL §5, T-1605):
 * what the card needs to offer them, worked out the same way wherever the
 * card opens (the list, a conversation).
 */
import type { GatewayState } from "../../lib/gateway";
import { canTakeOut, sendReport, setBlocked } from "../../lib/gateway";
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
  /**
   * Take them out of the room's voice they're in, as the host (#423): the
   * room's name, and the request. Left out unless you're the host and they're
   * in a room's voice.
   */
  takeOut?: { room: string; act: () => Promise<string | null> };
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
  // The room whose voice they're in: rooms only, since a DM's call isn't a
  // place the host reaches into, and the first in list order for somebody
  // in two on two computers.
  const voiceRoom = canTakeOut(state)
    ? [...state.rooms]
        .sort((a, b) => a.position - b.position)
        .find((room) => room.archived_at === null && (state.voice[room.id] ?? []).some((peer) => peer.user_id === user.id))
    : undefined;
  return {
    blocked: state.blocked.includes(user.id),
    host: hostName(state),
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
  };
}
