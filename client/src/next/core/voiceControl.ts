/**
 * Your voice controls pressed in a window other than the list: Mute, Deafen
 * and Leave on a chat window's voice line (#216). The list window owns voice
 * and makes the change; the window that was pressed plays the sound that
 * confirms it (#241, docs/design/architecture.md, "Viewer → owner").
 *
 * Why here and not in the list window: a sound is the click's answer, and
 * this is the window that was clicked. The list window may be hidden or
 * behind, and on Linux its sound for a click made here was heard seconds late.
 */
import { playSound, type SoundCue } from "../../lib/sound";
import { ask, type Bus, OWNER } from "./bus";
import { VOICE_CONTROL, type VoiceControlAnswer, type VoiceControlQuestion } from "./share";

/**
 * How long the list window's answer may take and still be played. A sound
 * that comes later reads as a fault rather than as the click's answer, so it
 * isn't played, though the change itself still happens. The player drops a
 * cue that would start more than a second late for the same reason
 * (`lib/sound.ts`).
 */
export const CONFIRM_WITHIN_MS = 1_000;

/**
 * Ask the list window to make the change, and play the sound that confirms it
 * once it has really happened. Nothing plays when nothing changed, when the
 * change failed, or when the answer came too late. Resolves to what played
 * (or would have, past the sound settings), for tests; never rejects.
 */
export async function pressVoiceControl(
  bus: Bus,
  press: VoiceControlQuestion,
  play: (cue: SoundCue) => unknown = playSound,
): Promise<SoundCue | null> {
  let cue: SoundCue | null;
  try {
    ({ cue } = await ask<VoiceControlAnswer>(bus, OWNER, VOICE_CONTROL, press, CONFIRM_WITHIN_MS));
  } catch {
    return null;
  }
  // The same player and settings as every other sound: Mute all and each
  // kind's own switch apply here exactly as they do in the list window.
  if (cue !== null) void play(cue);
  return cue;
}
