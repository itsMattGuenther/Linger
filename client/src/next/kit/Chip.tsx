import type { MouseEvent, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Marker, type MarkerPerson } from "./Marker";
import "./Chip.css";

/**
 * A small pill for a person or a picked thing, 24px tall. With `onRemove` the
 * whole chip is the remove button ("Remove Eli"), so there is no tiny target
 * inside a tiny chip.
 */
export function Chip({
  children,
  label,
  marker,
  active = false,
  state,
  note,
  onRemove,
  onActivate,
  actionLabel,
  expanded = false,
}: {
  /** What the chip shows: a `Name`, or words. */
  children: ReactNode;
  /** The words for it, used in "Remove …". */
  label: string;
  marker?: MarkerPerson;
  /** Lit in the lamp: the person is talking right now. */
  active?: boolean;
  /**
   * A state shown as its control's own glyph after the name, like muted or
   * deafened; the word is for screen readers. It sits after the name, so
   * gaining or losing it never moves the name.
   */
  state?: { icon: IconName; word: string };
  /** A short faint note at the end, like "connecting…". */
  note?: string;
  onRemove?: () => void;
  /**
   * Makes the whole chip a button that opens something about it, like a
   * voice chip's volume. `actionLabel` is its name ("Eli's volume, 100%").
   */
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
  actionLabel?: string;
  /** Whether what it opens is open now. */
  expanded?: boolean;
}) {
  const inner = (
    <>
      {marker ? <Marker color={marker.color} state={marker.state} size="sm" /> : null}
      <span className="k-chip-text">{children}</span>
      {state ? (
        <span className="k-chip-state">
          <Icon name={state.icon} size="sm" />
          <span className="k-sr-only">{state.word}</span>
        </span>
      ) : null}
      {note ? <span className="k-chip-note">{note}</span> : null}
      {onRemove ? <Icon name="close" size="sm" /> : null}
    </>
  );
  if (onActivate && !onRemove) {
    return (
      <button
        type="button"
        className="k-chip"
        data-kit="Chip"
        data-active={active ? "yes" : undefined}
        data-kit-control=""
        aria-label={actionLabel ?? label}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        onClick={onActivate}
      >
        {inner}
      </button>
    );
  }
  return onRemove ? (
    <button type="button" className="k-chip" data-kit="Chip" data-remove="" data-active={active ? "yes" : undefined} data-kit-control="" aria-label={`Remove ${label}`} onClick={onRemove}>
      {inner}
    </button>
  ) : (
    <span className="k-chip" data-kit="Chip" data-active={active ? "yes" : undefined}>
      {inner}
    </span>
  );
}
