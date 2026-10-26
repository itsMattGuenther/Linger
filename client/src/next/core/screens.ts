import type { RoomId } from "../../generated/RoomId";
import { type GatewayState, voicePeersIn } from "../../lib/gateway";
import type { ShareStopped } from "../../lib/screen/share";

/**
 * Who is sharing a screen and who is watching whom (SPEC §4.20, #360), read
 * from the server's `voice.state`, which says both for everybody in a room's
 * voice. Keyed by session, as voice is: somebody on two computers is two
 * seats, and a share is one of them.
 */

/** One share in a room's voice. */
export interface Sharer {
  session: string;
  userId: string;
  fps: 30 | 60;
}

/** The shares in a room's voice, in the server's order. */
export function sharersIn(state: GatewayState, roomId: RoomId): Sharer[] {
  return voicePeersIn(state, roomId).flatMap((peer) => (peer.screen ? [{ session: peer.session_id, userId: peer.user_id, fps: peer.screen.fps }] : []));
}

/** `userId`'s share in a room's voice, not this connection's own: its session, or null. */
export function shareBy(state: GatewayState, roomId: RoomId, userId: string): string | null {
  return sharersIn(state, roomId).find((one) => one.userId === userId && one.session !== state.sessionId)?.session ?? null;
}

/** Who is watching `session`'s share, as people, each once, in the server's order. */
export function watchersOf(state: GatewayState, roomId: RoomId, session: string): string[] {
  const seen = new Set<string>();
  for (const peer of voicePeersIn(state, roomId)) if (peer.watching === session) seen.add(peer.user_id);
  return [...seen];
}

/** The people sharing anywhere this person can see, by user id: the screen mark beside their name. */
export function sharingPeople(state: GatewayState): ReadonlySet<string> {
  const sharing = new Set<string>();
  for (const peers of Object.values(state.voice)) for (const peer of peers) if (peer.screen) sharing.add(peer.user_id);
  return sharing;
}

/** This connection's own seat, as the server has it: what it shares and watches. */
export function myScreen(state: GatewayState): { roomId: RoomId; sharing: boolean; watching: string | null } | null {
  const roomId = state.myVoice?.roomId;
  if (!roomId || state.sessionId === null) return null;
  const mine = voicePeersIn(state, roomId).find((peer) => peer.session_id === state.sessionId);
  if (!mine) return null;
  return { roomId, sharing: mine.screen !== undefined && mine.screen !== null, watching: mine.watching ?? null };
}

/** Whether this connection holds its voice seat in `roomId` now, as the server says. */
export function seatedIn(state: GatewayState, roomId: RoomId): boolean {
  return state.sessionId !== null && voicePeersIn(state, roomId).some((peer) => peer.session_id === state.sessionId);
}

/** The words for who is watching: "Matt, Eli and Dave are watching", never a number (SPEC §4.20, §4.2). */
export function watchingWords(names: readonly string[]): string {
  if (names.length === 0) return "Nobody's watching yet";
  if (names.length === 1) return `${names[0]} is watching`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are watching`;
}

/**
 * Why a share ended by itself, in words for the voice bar (#360); null when
 * there's nothing to say: you stopped it, or you left voice, which is plain
 * already.
 */
export function shareStoppedWords(why: ShareStopped): string | null {
  switch (why) {
    case "room-full":
      return "Three people are sharing here already, so yours didn't start.";
    case "not-signed-in":
      return "Sharing stopped: this server needs you to sign in again.";
    case "dropped":
      return "Sharing stopped: the connection to the server dropped.";
    case "no-encoder":
      return "This computer can't make the video Linger sends, so it can't share.";
    case "no-picker":
      return "This app can't ask for a screen on this computer.";
    case "no-screen":
      return "This computer didn't give Linger a screen to share.";
    case "no-frames":
      return "Linger couldn't read the screen you picked, so sharing stopped.";
    case "bad-hello":
      return "The server didn't take the share. It may need an update.";
    case "off":
      return "This server has screen sharing turned off.";
    case "not-in-voice":
    case "nothing-to-watch":
    case "replaced":
    case "ended":
      return null;
  }
}
