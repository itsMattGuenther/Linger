/**
 * The bits of the settings panel that can be wrong without looking wrong:
 * request bodies, the password floor, the display-name rules.
 *
 * The server is still the authority (PROTOCOL §2, §5). These copies exist so
 * the form can refuse a no-op, or say what's wrong with a name as it's typed,
 * before the round trip. The name rules use the server's own sentences.
 */
import type { ChangePasswordRequest } from "../generated/ChangePasswordRequest";
import type { UpdateMeRequest } from "../generated/UpdateMeRequest";
import { CHANGES_DIRECTION } from "./direction";

/**
 * `linger-core::limits::MAX_DISPLAY_NAME_CHARS`. ts-rs exports types, not
 * constants, so the number is written here. The server refuses anything longer.
 */
export const MAX_DISPLAY_NAME_CHARS = 32;

/** `linger-core::limits::MAX_ACCENT_MARKS_PER_LETTER` (#296). */
export const MAX_ACCENT_MARKS_PER_LETTER = 2;
/** `linger-core::limits::MAX_MARKS_PER_LETTER` (#296). */
export const MAX_MARKS_PER_LETTER = 4;

// The display-name rules (#296), one character at a time. Copied from
// `validate::display_name` on the server, which says why each is there.
const BREAKS_THE_LINE = /[\p{Cc}\u{2028}\u{2029}]/u;
const INVISIBLE = /[\p{Cf}\u{034F}\u{17B4}\u{17B5}]/u;
const EMOJI = /\p{Emoji}/u;
// The server's JOINING_SCRIPTS: Arabic, Syriac, N'Ko, Mandaic, Indic, Myanmar, Khmer, Mongolian, Adlam.
const JOINING_SCRIPTS =
  /[\u{0600}-\u{074F}\u{0750}-\u{077F}\u{07C0}-\u{07FF}\u{0840}-\u{08FF}\u{0900}-\u{0DFF}\u{1000}-\u{109F}\u{1780}-\u{18AF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFE}\u{1E900}-\u{1E95F}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const STACKING_MARK = /[\p{Mn}\p{Me}]/u;
const ACCENT = /[\u{0300}-\u{036F}\u{1AB0}-\u{1AFF}\u{1DC0}-\u{1DFF}\u{20D0}-\u{20FF}\u{FE20}-\u{FE2F}]/u;
const UNSEEN = /[\s\p{Z}\p{Cc}\p{Cf}\p{M}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{1D159}]/u;
const NAME_UNSEEN = "That name has no letters anyone can see.";

const ZWJ = "\u{200D}";
const ZWNJ = "\u{200C}";
const isEmoji = (c: string | undefined): boolean => c !== undefined && (c.codePointAt(0) ?? 0) > 0x7f && EMOJI.test(c);
const inJoiningWord = (c: string | undefined): boolean => c !== undefined && LETTER_OR_MARK.test(c) && JOINING_SCRIPTS.test(c);
const isTag = (c: string | undefined, last: number): boolean => {
  const code = c?.codePointAt(0) ?? 0;
  return code >= 0xe0020 && code <= last;
};

/** An invisible character that is part of how something is written: a joiner in an emoji or a word, or a flag's tags. */
function joinsHere(chars: readonly string[], at: number): boolean {
  const [before, c, after] = [chars[at - 1], chars[at], chars[at + 1]];
  if (c === ZWJ && (isEmoji(before) || before === "\u{FE0F}") && isEmoji(after)) return true;
  if (c === ZWNJ || c === ZWJ) return inJoiningWord(before) && inJoiningWord(after);
  if (isTag(c, 0xe007f)) return before === "\u{1F3F4}" || isTag(before, 0xe007e);
  return false;
}

/**
 * What's wrong with a display name, in the server's words, or null when
 * nothing is. An empty box isn't a problem, only not ready yet.
 */
export function displayNameProblem(typed: string): string | null {
  const name = typed.trim();
  if (name === "") return typed === "" ? null : NAME_UNSEEN;
  const chars = [...name];
  if (chars.length > MAX_DISPLAY_NAME_CHARS) return "Display names are 1–32 characters.";
  if (chars.some((c) => BREAKS_THE_LINE.test(c))) return "Names can't have tabs, line breaks or other control characters.";
  if (chars.some((c) => CHANGES_DIRECTION.test(c))) return "Names can't have characters that change the direction of text.";
  if (chars.some((c, at) => INVISIBLE.test(c) && !joinsHere(chars, at))) return "Names can't have invisible characters.";
  let marks = 0;
  let accents = 0;
  for (const c of chars) {
    if (!STACKING_MARK.test(c)) {
      marks = 0;
      accents = 0;
      continue;
    }
    marks += 1;
    if (ACCENT.test(c)) accents += 1;
    if (accents > MAX_ACCENT_MARKS_PER_LETTER) return "Names can't have more than two accent marks on one letter.";
    if (marks > MAX_MARKS_PER_LETTER) return "Names can't stack that many marks on one letter.";
  }
  return chars.some((c) => !UNSEEN.test(c)) ? null : NAME_UNSEEN;
}

/**
 * `linger-core::limits::MIN_PASSWORD_CHARS`. Same reason as the display-name
 * cap: the form greys the button out before the round trip. Minimum length is
 * the only rule — no symbols, no digits, no expiry (PROTOCOL §2).
 */
export const MIN_PASSWORD_CHARS = 8;

/** A PATCH /me that only touches the display name. Other fields stay put. */
export function displayNameRequest(name: string): UpdateMeRequest {
  return {
    display_name: name.trim(),
    style: null,
    status: null,
    entrance_sound: null,
  };
}

export function passwordRequest(
  current: string,
  next: string,
): ChangePasswordRequest {
  return { current_password: current, new_password: next };
}

/** Empty, unchanged, or refused by the name rules: not worth sending. */
export function displayNameReady(next: string, current: string): boolean {
  const name = next.trim();
  if (name === "" || displayNameProblem(next) !== null) return false;
  return name !== current.trim();
}

/** Both boxes filled, new one long enough, and actually different. */
export function passwordReady(current: string, next: string): boolean {
  return current.length > 0 && next.length >= MIN_PASSWORD_CHARS && current !== next;
}
