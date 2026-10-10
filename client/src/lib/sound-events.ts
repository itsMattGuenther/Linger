import type { ServerFrame } from "../generated/ServerFrame";
import type { GatewayState, MyVoice } from "./gateway";
import type { SoundCue } from "./sound";

/** Membership snapshots are silent unless our own voice session is affected. */
export function voiceCue(frame: ServerFrame, before: GatewayState, after: GatewayState): SoundCue | null {
  if (frame.op !== "voice.state" || before.sessionId === null) return null;
  const mine = before.myVoice;
  if (mine === null || mine.roomId !== frame.d.room_id) return null;
  const old = before.voice[mine.roomId] ?? [];
  const next = after.voice[mine.roomId] ?? [];
  const seated = next.some((peer) => peer.session_id === before.sessionId);
  if (!seated) return null;
  if (!old.some((peer) => peer.session_id === before.sessionId)) return mine.moved ? "voice-move" : "voice-join";
  const oldIds = new Set(old.map((peer) => peer.session_id));
  const nextIds = new Set(next.map((peer) => peer.session_id));
  if (next.some((peer) => !oldIds.has(peer.session_id))) return "peer-join";
  if (old.some((peer) => !nextIds.has(peer.session_id))) return "peer-leave";
  return null;
}

/** A person's arriving, and their leaving, each sound at most this often for you (#473). */
export const PEER_CUE_EVERY_MS = 60_000;

/**
 * Keeps somebody joining and leaving voice over and over from ringing
 * everybody already in it each time (#473). Each person's arriving and
 * leaving sound at most once a minute apiece, for each listener; your own
 * join, leave and move are yours and always sound. By person, not session:
 * one person's laptop and desktop arriving together is one arrival.
 */
export class PeerCueLimit {
  private readonly last = new Map<string, number>();

  constructor(private readonly every = PEER_CUE_EVERY_MS) {}

  /**
   * Whether a cue about these people may sound at `now`, noting it for all
   * of them if so. One of them due is enough: a crowd arriving together
   * sounds once, and anybody new among them is worth it.
   */
  allow(cue: "peer-join" | "peer-leave", people: readonly string[], now: number): boolean {
    const due = people.some((person) => {
      const at = this.last.get(`${cue}\u0000${person}`);
      return at === undefined || now - at >= this.every;
    });
    if (!due) return false;
    for (const person of people) this.last.set(`${cue}\u0000${person}`, now);
    return true;
  }
}

/** The voice cue this frame should play, if any, with other people's cues limited (#473). */
export function voiceCueToPlay(frame: ServerFrame, before: GatewayState, after: GatewayState, limit: PeerCueLimit, now: number): SoundCue | null {
  const cue = voiceCue(frame, before, after);
  if ((cue !== "peer-join" && cue !== "peer-leave") || frame.op !== "voice.state") return cue;
  const old = before.voice[frame.d.room_id] ?? [];
  const next = after.voice[frame.d.room_id] ?? [];
  const oldIds = new Set(old.map((peer) => peer.session_id));
  const nextIds = new Set(next.map((peer) => peer.session_id));
  const moved = cue === "peer-join" ? next.filter((peer) => !oldIds.has(peer.session_id)) : old.filter((peer) => !nextIds.has(peer.session_id));
  return limit.allow(cue, [...new Set(moved.map((peer) => peer.user_id))], now) ? cue : null;
}

/**
 * The sound that confirms a change to your own mute or deafen, if it makes
 * one. Deafening says so whatever it did to the microphone with it. Only
 * deliberate choices sound: push-to-talk's key opens and closes the
 * microphone without touching `muted` (#232), and turning push-to-talk on or
 * off doesn't either, so neither makes a sound. A Mute you choose under
 * push-to-talk is a real mute, and sounds like one.
 */
export function controlCue(before: MyVoice, after: MyVoice): SoundCue | null {
  if (before.deafened !== after.deafened) return after.deafened ? "deafen" : "undeafen";
  if (before.muted !== after.muted) return after.muted ? "mute" : "unmute";
  return null;
}
