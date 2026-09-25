import type { ReactNode } from "react";
import { Icon } from "./Icon";
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
  onRemove,
}: {
  /** What the chip shows: a `Name`, or words. */
  children: ReactNode;
  /** The words for it, used in "Remove …". */
  label: string;
  marker?: MarkerPerson;
  /** Lit in the lamp: the person is talking right now. */
  active?: boolean;
  onRemove?: () => void;
}) {
  const inner = (
    <>
      {marker ? <Marker color={marker.color} state={marker.state} size="sm" /> : null}
      <span className="k-chip-text">{children}</span>
      {onRemove ? <Icon name="close" size="sm" /> : null}
    </>
  );
  return onRemove ? (
    <button type="button" className="k-chip" data-kit="Chip" data-active={active ? "yes" : undefined} data-kit-control="" aria-label={`Remove ${label}`} onClick={onRemove}>
      {inner}
    </button>
  ) : (
    <span className="k-chip" data-kit="Chip" data-active={active ? "yes" : undefined}>
      {inner}
    </span>
  );
}
