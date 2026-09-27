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
