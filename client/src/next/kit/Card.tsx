import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { IconButton } from "./IconButton";
import { Sheet } from "./Sheet";
import "./Card.css";

function tintStyle(tint: string | undefined): CSSProperties | undefined {
  if (!tint || !/^[a-z]{2,16}$/.test(tint)) return undefined;
  return { "--card-tint": `var(--name-${tint})` } as CSSProperties;
}

/**
 * A grouped block on a surface: a raised panel with a hairline edge. `tint`
 * washes it faintly in a person's palette color (a key, never a value).
 */
export function Card({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <section className="k-card" data-kit="Card" data-tinted={tint ? "yes" : undefined} style={tintStyle(tint)}>
      {children}
    </section>
  );
}

/**
 * Something that floats over the window: a person's card, a menu, a picker.
 * A dialog with a name, a close button, and Escape to close. Where it floats
 * is the caller's business (`at`); its size is its own. With `sheet` (the
 * phone, SPEC §4.15) it rises from the bottom in a `Sheet` instead, which
 * sets its size, and a tap on the dimmed page closes it too.
 */
export function Popover({
  label,
  children,
  onClose,
  tint,
  arrow = "none",
  at,
  sheet = false,
}: {
  label: string;
  children: ReactNode;
  onClose?: () => void;
  tint?: string;
  /** A small pointer toward what opened it. */
  arrow?: "left" | "right" | "none";
  /** Fixed position in the window, in pixels. Without it, it sits in the flow. */
  at?: { x: number; y: number };
  /** Risen from the bottom, the whole width, on the phone: `at` is left out. */
  sheet?: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const style: CSSProperties = { ...tintStyle(tint), ...(at && !sheet ? { position: "fixed", left: at.x, top: at.y } : {}) };
  const card = (
    <div
      ref={box}
      className="k-popover"
      data-kit="Popover"
      data-sheet={sheet ? "yes" : undefined}
      data-arrow={sheet ? "none" : arrow}
      data-tinted={tint ? "yes" : undefined}
      role="dialog"
      aria-label={label}
      style={style}
    >
      {onClose ? (
        <span className="k-popover-close">
          <IconButton icon="close" label="Close" size="sm" shortcut="Esc" onClick={onClose} />
        </span>
      ) : null}
      {children}
    </div>
  );
  return sheet ? <Sheet onClose={onClose}>{card}</Sheet> : card;
}
