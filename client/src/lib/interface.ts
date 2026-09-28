/** Private display preferences. They never leave this computer. */

export const SCALE_OPTIONS = [100, 110, 125, 150, 175, 200] as const;

export function validScale(value: unknown): number {
  return typeof value === "number" &&
    SCALE_OPTIONS.some((option) => option === value)
    ? value
    : 100;
}
