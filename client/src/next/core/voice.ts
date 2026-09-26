/**
 * What the voice bar shows (docs/design/buddy-list.md, "Voice belongs to the
 * room, not the tab or window"), worked out from the store. Pure; the list
 * window adds the controls, which act in the owner.
 */
import type { RoomId } from "../../generated/RoomId";
import type { User } from "../../generated/User";
import { dmLabel } from "../../lib/dm";
import { type GatewayState, voicePeersIn } from "../../lib/gateway";
import { microphoneLine } from "../../lib/voice";

/** One person in voice, as the voice bar shows them. */
export interface VoicePerson {
  user: User;
  speaking: boolean;
  you: boolean;
  /**
   * Their microphone as their client shares it (VOICE-6): muted, deafened,
   * or unknown when their client or server doesn't share it. Null when it's on.
   */
  controls: "muted" | "deafened" | "unknown" | null;
  /** Trouble reaching them from here (VOICE-7), while you're both in voice. */
  link: "connecting" | "unreachable" | null;
}

export interface VoiceModel {
  roomId: RoomId;
  /** "#general", or the DM's people. */
  where: string;
  /** Everyone in voice there, you included, in the order the server lists them. */
  people: VoicePerson[];
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  /** The one thing worth saying about your microphone, if anything. */
  line: string | null;
}

/**
 * The voice bar, when you're in voice on this server; null when you aren't.
 * `speaking` is who is talking by user id, known only from the audio you hear.
 */
export function voiceModel(state: GatewayState, speaking: ReadonlySet<string>): VoiceModel | null {
  const mine = state.myVoice;
  const me = state.me;
  if (mine === null || me === null) return null;
  const room = state.rooms.find((held) => held.id === mine.roomId);
  const dm = state.dms.find((held) => held.id === mine.roomId);
  const where = room ? `#${room.name}` : dm ? dmLabel(dm, state.users, me.id) : "a room";
  const peers = voicePeersIn(state, mine.roomId);
  const ids = new Set(peers.map((peer) => peer.user_id));
  ids.add(me.id);
  const people = state.users
    .filter((user) => ids.has(user.id))
    .map((user): VoicePerson => {
      const you = user.id === me.id;
      // Somebody on two computers is two peers; the first one speaks for them.
      const peer = peers.find((one) => one.user_id === user.id);
      return {
        user,
        you,
        speaking: you ? mine.talking : speaking.has(user.id),
        controls: you ? controlsOf(mine) : peer?.controls === undefined ? "unknown" : controlsOf(peer.controls),
        link: you || !peer ? null : linkOf(mine.peers[peer.session_id]),
      };
    });
  return {
    roomId: mine.roomId,
    where,
    people,
    muted: mine.muted,
    deafened: mine.deafened,
    pushToTalk: mine.pushToTalk,
    line: microphoneLine(mine.audio, mine.pushToTalk, mine.muted),
  };
}

/** Who is talking, by user id: known only while you're in voice, from the audio you hear. */
export function talkingNow(state: GatewayState): ReadonlySet<string> {
  const mine = state.myVoice;
  if (mine === null) return new Set();
  const peers = state.voice[mine.roomId] ?? [];
  const bySession = new Map(peers.map((peer) => [peer.session_id, peer.user_id]));
  const ids = Object.entries(mine.speaking)
    .filter(([, on]) => on)
    .map(([session]) => bySession.get(session))
    .filter((id): id is string => id !== undefined);
  return new Set(ids);
}

function controlsOf(controls: { muted: boolean; deafened: boolean }): VoicePerson["controls"] {
  return controls.deafened ? "deafened" : controls.muted ? "muted" : null;
}

/** A peer connection's state (the core's words) as trouble worth saying, if any. */
function linkOf(state: string | undefined): VoicePerson["link"] {
  if (state === "new" || state === "connecting") return "connecting";
  if (state === "failed" || state === "disconnected") return "unreachable";
  return null;
}
