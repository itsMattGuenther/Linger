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
  | { kind: "quiet"; action: "start" | "move" }
  /** The server carries no voice: its host hasn't set it up (#306). Nothing to offer. */
  | { kind: "off" };

/**
 * `here` is who is in voice in this room (user ids, server order), `meId`
 * you, and `mineIn` the conversation your own seat is in (on any server),
 * or null when you're not in voice. Moving is offered, never a fresh join,
 * when you're already in voice somewhere else: one voice room at a time.
 * `carries` is false when the server has said it has no voice (#306); a
 * server that hasn't said is given the benefit of the doubt.
 */
export function voiceStrip(conversation: string, here: readonly string[], meId: string | null, mineIn: string | null, carries = true): VoiceStrip {
  const others = here.filter((id) => id !== meId);
  if (mineIn === conversation) return { kind: "mine", people: [...here] };
  if (!carries && others.length === 0) return { kind: "off" };
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

/**
 * A voice strip's chips, as measured on its one line (#745): each person's
 * chip width in the strip's order, the space between two chips, and how wide
 * the words after them are with "and others" in them (`some`) and without
 * (`all`). `you` is you, when you're in voice here and among them.
 */
export interface StripMeasure {
  chips: readonly { id: string; width: number }[];
  gap: number;
  words: { some: number; all: number };
  you: string | null;
}

/**
 * How the strip fills its line (#745): everybody; the first `count` in its
 * order, then "and others"; or, in a big room you're in, you and `seats`
 * seats for whoever just talked (#197).
 */
export type StripFit = { kind: "all" } | { kind: "first"; count: number } | { kind: "seats"; seats: number };

/** Half a pixel: widths are measured in fractions, and rounding mustn't drop a chip that fits. */
const SLACK = 0.5;

/**
 * As many people as fit `room`, the width the chips and the words after them
 * share, rather than a fixed four, which left a wide window's strip half
 * empty (#745). Everybody when they all fit; otherwise as many as fit beside
 * "and others", never fewer than one, which is cut to fit as before.
 *
 * In a big room you're in, `seats` seats fit when the widest that many of
 * the others would: who sits in them changes as people talk, and a wider
 * name taking a seat must never push the last one off the line. So how many
 * there are changes only with the room or the window, never with who talks.
 */
export function stripFit(measure: StripMeasure, room: number): StripFit {
  const { chips, gap, words, you } = measure;
  const span = (widths: readonly number[]) => widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  const widths = chips.map((chip) => chip.width);
  if (span(widths) + words.all <= room + SLACK) return { kind: "all" };
  const yours = you === null ? undefined : chips.find((chip) => chip.id === you);
  if (yours) {
    const widest = chips.filter((chip) => chip !== yours).map((chip) => chip.width).sort((a, b) => b - a);
    let seats = 0;
    let used = yours.width + words.some;
    // Everybody seated would be everybody shown: one is always left to "and others".
    while (seats < widest.length - 1 && used + gap + (widest[seats] ?? 0) <= room + SLACK) {
      used += gap + (widest[seats] ?? 0);
      seats += 1;
    }
    return { kind: "seats", seats };
  }
  let count = 1;
  while (count < widths.length && span(widths.slice(0, count + 1)) + words.some <= room + SLACK) count += 1;
  return { kind: "first", count };
}
