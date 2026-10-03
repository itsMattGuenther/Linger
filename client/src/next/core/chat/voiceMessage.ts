/**
 * A voice message in the message box (#401): a clip you record of yourself,
 * hear back, and choose to send. What its panel shows, per conversation, and
 * the words it uses. Pure; the window records and sends
 * (app/chat/useVoiceMessages.ts), and the desktop shell holds the microphone
 * (src-tauri/src/clip.rs).
 *
 * Always a toggle, never press-and-hold: a finger slips off and a hold sends
 * half a thought. And stopping never sends: you hear it back first.
 */

/** The longest a voice message runs. The recorder stops there by itself. */
export const LONGEST_MS = 5 * 60_000;

/**
 * Shorter than this isn't a message, it's Record and Stop pressed by mistake.
 * Half a second is also more than the server needs to know the file for what
 * it is.
 */
export const SHORTEST_MS = 500;

/** How many of the latest levels the moving lines show: two seconds of voice, at 25 a second. */
export const LINES = 48;

/** The name a voice message goes up as. A message's audio shows as a voice message by it. */
export const VOICE_MESSAGE_NAME = "Voice message.webm";

export type VoiceMessage =
  /** The panel is open: Record when ready. */
  | { kind: "ready"; problem: string | null }
  /** The microphone is opening. */
  | { kind: "starting" }
  /** Recording since `since` (ms since the epoch), with how loud each moment was, latest last. */
  | { kind: "recording"; since: number; levels: readonly number[] }
  /** Stopped; the clip is being put together. */
  | { kind: "stopping" }
  /** Recorded: listen back, then Send or Discard. */
  | { kind: "kept"; url: string; file: File; ms: number; note: string | null; sending: boolean; problem: string | null };

/** The latest level added to the lines, the oldest dropping off the front. */
export function withLevel(levels: readonly number[], level: number): number[] {
  const next = [...levels, Math.max(0, Math.min(1, level))];
  return next.length > LINES ? next.slice(next.length - LINES) : next;
}

/** "0:07", "4:59": a clip's length or how long it's been recording. */
export function clipTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Said when the recorder stopped by itself at the longest a clip runs. */
export const FULL_NOTE = "That's five minutes, the longest a voice message runs.";
/** Said when the microphone went away part way through. */
export const LOST_NOTE = "The microphone stopped. This is what was recorded.";
/** Said when Stop came too soon to keep anything. */
export const TOO_SHORT = "That was too short to send. Press Record, then talk.";

/** Whether a file in a message is a voice message, by the name it went up as. */
export function isVoiceMessage(filename: string, mime: string): boolean {
  return filename === VOICE_MESSAGE_NAME && mime === "audio/webm";
}
