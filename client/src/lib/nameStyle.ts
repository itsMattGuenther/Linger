/**
 * The arithmetic behind the style picker (SPEC §4.5) — the parts that can be
 * wrong without looking wrong.
 *
 * A `Style` off the wire is a flat record and the picker is a set of small
 * choices, so this is the translation between them, plus the two questions the
 * form asks constantly: is anything different from what is saved, and what
 * exactly do we send.
 *
 * The server validates every key against `linger-core::PALETTE` and
 * `linger-core::FONTS` (AGENTS rule 8), and it is the authority. The checks
 * here exist so the form can refuse a no-op before the round trip and so a key
 * this build has never heard of falls back to something drawable — not so the
 * client can second-guess the server.
 */
import type { Style } from "../generated/Style";
import type { UpdateMeRequest } from "../generated/UpdateMeRequest";
import type { User } from "../generated/User";
import { isFontKey, isMessageFontKey } from "./fonts";
import { isPaletteKey } from "./palette";

/** The three weights SPEC §4.5 offers. Not a range, not a slider. */
export const WEIGHTS = [400, 500, 700] as const;
export type Weight = (typeof WEIGHTS)[number];

/** none / slow shimmer / soft glow, and nothing else. */
export const EFFECTS = ["none", "shimmer", "glow"] as const;

/** Which half of a gradient a swatch click lands on. */
export type Slot = "from" | "to";

/**
 * The picker's own shape. It differs from `Style` in exactly one way: it keeps
 * both gradient colors even while the fill is solid, so turning the gradient
 * off and back on again returns what you had instead of a default.
 */
export interface StyleDraft {
  fontKey: string;
  weight: Weight;
  italic: boolean;
  gradient: boolean;
  from: string;
  to: string;
  effect: (typeof EFFECTS)[number];
  msgFontKey: string | null;
}

/** The palette key a fill falls back to when the saved one is unusable. */
const FALLBACK_COLOR = "slate";
/** The face a style falls back to. `linger-core`'s `Style::default` agrees. */
const FALLBACK_FONT = "geist-sans";

function weightOf(value: number): Weight {
  return WEIGHTS.find((w) => w === value) ?? 500;
}

function colorOf(key: string | undefined): string {
  return key !== undefined && isPaletteKey(key) ? key : FALLBACK_COLOR;
}

function fontOf(key: string | undefined | null): string {
  return typeof key === "string" && isFontKey(key) ? key : FALLBACK_FONT;
}

/** Open the picker on what the person already has. */
export function draftOf(style: Style): StyleDraft {
  const gradient = style.fill.kind === "gradient";
  const first = style.fill.kind === "solid" ? style.fill.color : style.fill.from;
  return {
    fontKey: fontOf(style.font_key),
    weight: weightOf(style.weight),
    italic: style.italic,
    gradient,
    from: colorOf(first),
    // The second half of a gradient nobody has made yet: the same color, so the
    // first click on `to` is a change and not a surprise.
    to: colorOf(style.fill.kind === "gradient" ? style.fill.to : first),
    effect: style.effect,
    msgFontKey: typeof style.msg_font_key === "string" && isMessageFontKey(style.msg_font_key)
      ? style.msg_font_key
      : null,
  };
}

/** The wire shape the draft describes. */
export function styleOf(draft: StyleDraft): Style {
  return {
    font_key: draft.fontKey,
    weight: draft.weight,
    italic: draft.italic,
    fill: draft.gradient
      ? { kind: "gradient", from: draft.from, to: draft.to }
      : { kind: "solid", color: draft.from },
    effect: draft.effect,
    msg_font_key: draft.msgFontKey,
  };
}

/** A `PATCH /me` that touches the style and nothing else. */
export function styleRequest(draft: StyleDraft): UpdateMeRequest {
  return {
    display_name: null,
    style: styleOf(draft),
    status: null,
    entrance_sound: null,
  };
}

/**
 * A user with the draft's style on them, for the live preview.
 *
 * The preview draws through the same `nameProps` every other name in the app
 * goes through — that is the point of it. Building the person the draft
 * describes is cheaper and more honest than a second rendering path that could
 * disagree with the real one.
 */
export function previewUser(user: User, draft: StyleDraft): User {
  return { ...user, style: styleOf(draft) };
}

/** Nothing to save. Compared through the wire shape, which is what is sent. */
export function isDirty(draft: StyleDraft, saved: Style): boolean {
  const next = styleOf(draft);
  const now = styleOf(draftOf(saved));
  return JSON.stringify(next) !== JSON.stringify(now);
}

/** Set one half of the fill. Solid fills only ever use `from`. */
export function withColor(draft: StyleDraft, slot: Slot, key: string): StyleDraft {
  return slot === "from" ? { ...draft, from: key } : { ...draft, to: key };
}
