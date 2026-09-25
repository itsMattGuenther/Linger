import type { ReactNode } from "react";
import { Icon } from "./Icon";
import "./SectionLabel.css";

export interface SectionLabelProps {
  label: string;
  /** A section ("Rooms") or a group inside one ("Away"). Same look, less space above. */
  level?: "section" | "group";
  /** Foldable: pass `open` and `onToggle`. Without them it is a plain heading. */
  open?: boolean;
  onToggle?: () => void;
  /** The id of the region it folds, for `aria-controls`. */
  controls?: string;
  /** One small `IconButton` (size sm) at the end, like "New message". */
  action?: ReactNode;
}

/**
 * A small uppercase label over a part of a list. When it folds, its caret
 * sits in the rows' lead column, so carets line up with the markers under
 * them, and it says "show" while folded and "hide" on hover while open.
 */
export function SectionLabel({ label, level = "section", open, onToggle, controls, action }: SectionLabelProps) {
  const foldable = onToggle !== undefined && open !== undefined;
  const inner = (
    <>
      <span className="k-section-slot" aria-hidden="true">
        {foldable ? <Icon name="caret" size="sm" /> : null}
      </span>
      <span className="k-section-text">{label}</span>
      {foldable ? <span className="k-section-hint">{open ? "hide" : "show"}</span> : null}
    </>
  );
  return (
    <div className="k-section" data-kit="SectionLabel" data-level={level} data-open={open === false ? "no" : "yes"}>
      {foldable ? (
        <button
          type="button"
          className="k-section-toggle"
          data-kit-control=""
          aria-expanded={open}
          aria-controls={controls}
          onClick={onToggle}
        >
          {inner}
        </button>
      ) : (
        <h3 className="k-section-toggle" data-static="">
          {inner}
        </h3>
      )}
      {action ? <span className="k-section-action">{action}</span> : null}
    </div>
  );
}
