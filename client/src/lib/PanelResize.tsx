import { useRef } from "react";
import { clampPanel, PANEL_LIMITS, type PanelSide } from "./interface";

/** A real keyboard separator, not a pointer-only decoration. */
export default function PanelResize({
  side,
  value,
  scale,
  onChange,
}: {
  side: PanelSide;
  value: number;
  scale: number;
  onChange: (value: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const limits = PANEL_LIMITS[side];
  const direction = side === "rail" ? 1 : -1;
  const change = (width: number) => onChange(clampPanel(side, width));
  return (
    <div
      className={`panel-resize panel-resize-${side}`}
      role="separator"
      tabIndex={0}
      aria-label={side === "rail" ? "Resize navigation" : "Resize people panel"}
      aria-orientation="vertical"
      aria-controls={side === "rail" ? "navigation" : "people-panel"}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      title="Drag to resize · arrow keys to adjust · double-click to reset"
      onDoubleClick={() => change(limits.initial)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        change(
          event.key === "Home"
            ? limits.min
            : event.key === "End"
              ? limits.max
              : value +
                (event.key === "ArrowRight" ? 1 : -1) *
                  direction *
                  (event.shiftKey ? 32 : 8),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        start.current = { x: event.clientX, width: value };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.currentTarget.focus();
      }}
      onPointerMove={(event) => {
        if (start.current)
          change(
            start.current.width +
              ((event.clientX - start.current.x) * direction) / (scale / 100),
          );
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onLostPointerCapture={() => {
        start.current = null;
      }}
    />
  );
}
