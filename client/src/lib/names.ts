/**
 * The name rendering engine (SPEC §4.5) — how a person is drawn, wherever they
 * are drawn.
 *
 * AIM had no profile pictures; it had decorated names, and people put real work
 * into them. Everything a person controls about their own name — face, weight,
 * slant, one palette color or a gradient of two, and an effect — arrives here as
 * a `Style` off the wire and leaves as custom properties plus two data
 * attributes. Nothing in this file knows what "azure" looks like: the colors are
 * `--name-*` variables generated from `linger-core::PALETTE` into
 * `generated/palette.generated.css`, which is the only place in the codebase a
 * key becomes a color (AGENTS rule 12).
 *
 * The split is deliberate:
 *
 * - [`personStyle`] goes on a *container* — a stream row, a roster card, a
 *   popover. It sets the custom properties, so message fonts and the accents
 *   on status cards come from the same place as names and cannot drift apart.
 * - [`nameProps`] goes on the *name itself*. It re-states the same properties
 *   (harmless, and it means a name works with no styled ancestor at all) and
 *   adds the class and the attributes `styles/names.css` paints from.
 *
 * The painting is CSS, not React, for one reason: "normalize everyone"
 * (SPEC §4.5, constraint 5) has to flatten every name in the app at once, and a
 * reader-side switch that has to reach every component is a switch that will one
 * day miss one. It is an attribute on `<html>` and a handful of rules that
 * outrank these values, and it cannot miss anything.
 */
import type { CSSProperties } from "react";

import type { NameEffect } from "../generated/NameEffect";
import type { User } from "../generated/User";
import { fontVar, messageFontVar } from "./fonts";

/**
 * Everything a container hands down: the rule colour, the name colour, the
 * second colour of a gradient, and the three typographic choices.
 *
 * The 92° gradient angle is not here. It is fixed (SPEC §4.5, constraint 3) and
 * lives once, in `names.css`, where nobody can make it a setting by accident.
 */
export function personStyle(person: User | undefined): CSSProperties {
  const style = person?.style;
  const key = paletteKey(person);
  const color = key === null ? null : `var(--name-${key}, var(--text-primary))`;
  const second = secondKey(person);
  return {
    "--person-rule": key === null ? "var(--hairline-strong)" : `var(--name-${key}, var(--hairline-strong))`,
    "--person-name": color ?? "var(--text-primary)",
    // Only a gradient sets this; a solid fill leaves the paint flat.
    "--person-to": second === null ? undefined : `var(--name-${second}, ${color ?? "var(--text-primary)"})`,
    "--person-font": fontVar(style?.font_key, "var(--font-ui)"),
    "--person-weight": style?.weight ?? 500,
    "--person-slant": style?.italic === true ? "italic" : "normal",
    // The *only* message styling that exists (SPEC §4.5): a face, nothing else.
    // No colour, no size, no background — the name carries the identity and the
    // body stays legible.
    "--person-msg-font": messageFontVar(style?.msg_font_key),
  };
}

/** What [`nameProps`] returns: spread it onto the element that draws the name. */
export interface NameProps {
  className: string;
  style: CSSProperties;
  "data-name-fill"?: "gradient";
  "data-name-effect"?: NameEffect;
}

/**
 * The props for one drawn name. `extra` is whatever class the surface already
 * had — `msg-author`, `person-name` — because each of those still
 * owns its own size and truncation; this owns the person.
 */
export function nameProps(person: User | undefined, extra?: string): NameProps {
  const effect = person?.style.effect;
  return {
    className: extra === undefined ? "name" : `name ${extra}`,
    style: personStyle(person),
    "data-name-fill": secondKey(person) === null ? undefined : "gradient",
    // `none` is left off entirely rather than written out, so the attribute
    // selectors in names.css are the whole test for "does this name do anything".
    "data-name-effect": effect === undefined || effect === "none" ? undefined : effect,
  };
}

/**
 * The person's first (or only) palette key, or null for somebody with no style
 * we can use.
 */
export function paletteKey(person: User | undefined): string | null {
  if (!person) return null;
  // A gradient name takes its rule and its first stop from the first of its two
  // colors, so both fills answer this the same way.
  const fill = person.style.fill;
  return safeKey(fill.kind === "solid" ? fill.color : fill.from);
}

/** The second stop of a gradient, or null for a solid fill. */
function secondKey(person: User | undefined): string | null {
  if (!person) return null;
  const fill = person.style.fill;
  return fill.kind === "gradient" ? safeKey(fill.to) : null;
}

/**
 * The server validates keys against `linger-core::PALETTE` (AGENTS rule 8);
 * this is the second lock on the door, because the key is about to become part
 * of a CSS variable name and user content is hostile (ARCHITECTURE §7).
 */
function safeKey(key: string): string | null {
  return /^[a-z]{2,16}$/.test(key) ? key : null;
}
