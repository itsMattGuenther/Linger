import { type CSSProperties, useEffect, useRef } from "react";
import "./Slider.css";

/**
 * A value along a line, such as how loud somebody is for you. A native range
 * input, so the arrow keys, Page Up and Down, Home and End all work, and a
 * screen reader hears `valueText` rather than a bare number. It is 24px tall
 * and as wide as whatever holds it; the part before the thumb is lit.
 *
 * `onChange` fires on every step of a drag. `onCommit` fires once the person
 * lets go: the pointer comes up after a drag or a click on the track, or the
 * key that moved it is released (holding an arrow down is one change, not
 * one per repeat). A press that moved nothing commits nothing.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  valueText,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What the value means in words, like "150%". */
  valueText: string;
  onChange: (value: number) => void;
  /** The person let go, at this value: for something to do once, like playing a sample. */
  onCommit?: (value: number) => void;
}) {
  const lit = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  const input = useRef<HTMLInputElement | null>(null);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  // A key down on the slider: "held" until it moves the value, then "moved".
  const keys = useRef<"idle" | "held" | "moved">("idle");
  const release = (at: HTMLInputElement) => {
    const moved = keys.current === "moved";
    keys.current = "idle";
    if (moved) commit.current?.(Number(at.value));
  };

  // React's onChange is the input event, one per step. The native change
  // event is the browser saying a drag was let go of; it also fires on every
  // key step, so while a key is down it only marks a move, and the key's
  // release commits.
  useEffect(() => {
    const node = input.current;
    if (node === null) return;
    const onLetGo = () => {
      if (keys.current !== "idle") keys.current = "moved";
      else commit.current?.(Number(node.value));
    };
    node.addEventListener("change", onLetGo);
    return () => node.removeEventListener("change", onLetGo);
  }, []);

  return (
    <input
      ref={input}
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
      onChange={(event) => {
        if (keys.current !== "idle") keys.current = "moved";
        onChange(Number(event.currentTarget.value));
      }}
      onKeyDown={() => {
        if (keys.current === "idle") keys.current = "held";
      }}
      onKeyUp={(event) => release(event.currentTarget)}
      onBlur={(event) => release(event.currentTarget)}
      style={{ "--k-slider-lit": `${lit}%` } as CSSProperties}
    />
  );
}
