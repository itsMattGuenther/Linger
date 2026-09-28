/**
 * The sixteen palette keys, in picker order.
 *
 * `linger-core::PALETTE` is the one definition of the palette (SPEC §5.4) and
 * the server validates every key it is sent against it, because client-side
 * validation alone is a defect (AGENTS rule 8). This list is a mirror kept for
 * the pickers to iterate over, the same way `EditBox.tsx` mirrors
 * `MAX_MESSAGE_CHARS`: the server stays the authority, and a key this build has
 * never heard of is still refused there.
 *
 * It holds *keys*, never colors. What "azure" looks like is a CSS custom
 * property M6 generates from the Rust table, so nothing in the frontend has
 * ever seen a hex value (AGENTS rule 12).
 */
export const PALETTE_KEYS = [
  "ember",
  "rust",
  "amber",
  "brass",
  "lime",
  "fern",
  "mint",
  "teal",
  "cyan",
  "sky",
  "azure",
  "indigo",
  "violet",
  "orchid",
  "rose",
  "slate",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];

export function isPaletteKey(value: string): value is PaletteKey {
  return PALETTE_KEYS.some((key) => key === value);
}
