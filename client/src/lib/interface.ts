/** Private display preferences. They never leave this computer. */

export const SCALE_OPTIONS = [100, 110, 125, 150, 175, 200] as const;

export function validScale(value: unknown): number {
  return typeof value === "number" &&
    SCALE_OPTIONS.some((option) => option === value)
    ? value
    : 100;
}

/**
 * The phone's own Text size (#690), on top of the phone's text size setting:
 * smaller steps than Interface size, so a phone's screen still holds a
 * conversation.
 */
export const TEXT_SIZE_OPTIONS = [100, 115, 130, 150] as const;

export function validTextSize(value: unknown): number {
  return typeof value === "number" &&
    TEXT_SIZE_OPTIONS.some((option) => option === value)
    ? value
    : 100;
}
