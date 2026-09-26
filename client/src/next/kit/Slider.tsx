import type { CSSProperties } from "react";
import "./Slider.css";

/**
 * A value along a line, such as how loud somebody is for you. A native range
 * input, so the arrow keys, Page Up and Down, Home and End all work, and a
 * screen reader hears `valueText` rather than a bare number. It is 24px tall
 * and as wide as whatever holds it; the part before the thumb is lit.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  valueText,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What the value means in words, like "150%". */
  valueText: string;
  onChange: (value: number) => void;
}) {
  const lit = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="k-slider"
      data-kit="Slider"
      data-kit-control=""
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      style={{ "--k-slider-lit": `${lit}%` } as CSSProperties}
    />
  );
}
