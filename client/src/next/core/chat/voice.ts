/**
 * What a conversation's voice strip says (docs/design/buddy-list.md, "Voice
 * belongs to the room, not the tab or window"). Voice controls live in the
 * list's voice bar; the strip only says what is happening here and offers
 * one way in.
 */

export type VoiceStrip =
  /** You're in voice in this room. No buttons: the list's bar has them. */
  | { kind: "mine"; people: string[] }
  /** Others are talking here. `action` is how you'd join them. */
  | { kind: "others"; people: string[]; action: "join" | "move" }
  /** Nobody is in voice here. */
  | { kind: "quiet"; action: "start" | "move" };

/**
 * `here` is who is in voice in this room (user ids, server order), `meId`
 * you, and `mineIn` the conversation your own seat is in (on any server),
 * or null when you're not in voice. Moving is offered, never a fresh join,
 * when you're already in voice somewhere else: one voice room at a time.
 */
export function voiceStrip(conversation: string, here: readonly string[], meId: string | null, mineIn: string | null): VoiceStrip {
  const others = here.filter((id) => id !== meId);
  if (mineIn === conversation) return { kind: "mine", people: [...here] };
  const elsewhere = mineIn !== null;
  if (others.length > 0) return { kind: "others", people: others, action: elsewhere ? "move" : "join" };
  return { kind: "quiet", action: elsewhere ? "move" : "start" };
}

/** The button's words for each way in. */
export const VOICE_ACTION_WORDS: Record<"join" | "move" | "start", string> = {
  join: "Join",
  move: "Move voice here",
  start: "Start talking",
};

/** The quiet strip's button, which says it moves you when you're elsewhere. */
export const QUIET_MOVE_WORDS = "Talk here instead";
