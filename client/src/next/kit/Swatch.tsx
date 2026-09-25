import type { CSSProperties } from "react";
import "./Swatch.css";

/**
 * One of the 16 palette colors as a 24px choice. The wire holds the key
 * ("azure"); the color comes from the generated palette (AGENTS rule 12).
 */
export function Swatch({
  colorKey,
  label,
  pressed,
  onClick,
}: {
  colorKey: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const key = /^[a-z]{2,16}$/.test(colorKey) ? colorKey : "slate";
  return (
    <button
      type="button"
      className="k-swatch"
      data-kit="Swatch"
      data-kit-control=""
      aria-label={label}
      aria-pressed={pressed}
      style={{ "--swatch-color": `var(--name-${key})` } as CSSProperties}
      onClick={onClick}
    />
  );
}
