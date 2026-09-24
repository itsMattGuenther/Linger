import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useId,
  useState,
} from "react";

import Tooltip from "./Tooltip";

/** Familiar toolbar actions keep their names available to keyboard and pointer users. */
export default function IconButton({
  label,
  tooltip,
  children,
  className = "",
  tooltipSide = "above",
  floatingTooltip = false,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  /** Shorter hover name. Screen readers still hear `label`. */
  tooltip?: string;
  children: ReactNode;
  tooltipSide?: "above" | "below";
  /**
   * Draw the hover name with [`Tooltip`], outside the page's boxes, instead of
   * on the button itself. For buttons inside a box that scrolls or is short
   * enough to cut the name off (#140). `tooltipSide` becomes a preference: the
   * name goes wherever the window has room.
   */
  floatingTooltip?: boolean;
}) {
  const tooltipId = useId();
  const [shownOn, setShownOn] = useState<HTMLButtonElement | null>(null);
  const name = tooltip ?? label;
  if (!floatingTooltip) {
    return (
      <button
        type="button"
        {...props}
        aria-label={label}
        data-tooltip={name}
        data-tooltip-side={tooltipSide}
        className={`ui-icon ${className}`}
      >
        {children}
      </button>
    );
  }
  // The same moments the CSS tooltip shows: under the pointer, or focused
  // from the keyboard. Escape hides it without moving focus.
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      data-tooltip={name}
      data-tooltip-floating=""
      className={`ui-icon ${className}`}
      onPointerEnter={(event) => {
        props.onPointerEnter?.(event);
        setShownOn(event.currentTarget);
      }}
      onPointerLeave={(event) => {
        props.onPointerLeave?.(event);
        if (event.currentTarget !== document.activeElement ||
          !event.currentTarget.matches(":focus-visible")) setShownOn(null);
      }}
      onFocus={(event) => {
        props.onFocus?.(event);
        if (event.currentTarget.matches(":focus-visible"))
          setShownOn(event.currentTarget);
      }}
      onBlur={(event) => {
        props.onBlur?.(event);
        if (!event.currentTarget.matches(":hover")) setShownOn(null);
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.key === "Escape") setShownOn(null);
      }}
    >
      {children}
      {shownOn ? (
        <Tooltip anchor={shownOn} id={tooltipId} prefer={tooltipSide}>
          {name}
        </Tooltip>
      ) : null}
    </button>
  );
}
