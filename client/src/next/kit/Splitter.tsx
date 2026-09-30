import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import "./Splitter.css";

/**
 * The line between two panes, moved by dragging it: the buddy list's width
 * beside the conversations (#337). It draws a 1px hairline and takes presses
 * a little either side of it, and the pointer shows it resizes.
 *
 * It is a separator in the ARIA sense, the one that moves (`role="separator"`
 * with a value), and it takes the keyboard: the arrows move it a `step` at a
 * time, Home and End go to either end, and Enter, like a double press, puts
 * it back to `reset`. `value` is the width of what's before it, in the page's
 * pixels; `onChange` fires on every step of a drag.
 */
export function Splitter({
  label,
  value,
  min,
  max,
  step = 16,
  reset,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Where Enter and a double press put it back to. */
  reset?: number;
  onChange: (value: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const move = (next: number) => {
    const clamped = clamp(next);
    if (clamped !== value) onChange(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, value };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (from) move(from.value + event.clientX - from.x);
  };
  const letGo = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? value - step
        : event.key === "ArrowRight"
          ? value + step
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : event.key === "Enter" && reset !== undefined
                ? reset
                : null;
    if (next === null) return;
    event.preventDefault();
    move(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="k-splitter"
      data-kit="Splitter"
      data-dragging={dragging ? "yes" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={letGo}
      onPointerCancel={letGo}
      onDoubleClick={reset === undefined ? undefined : () => move(reset)}
      onKeyDown={onKeyDown}
    />
  );
}
