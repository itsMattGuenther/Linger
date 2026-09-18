import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Familiar toolbar actions keep their names available to keyboard and pointer users. */
export default function IconButton({
  label,
  children,
  className = "",
  tooltipSide = "above",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  children: ReactNode;
  tooltipSide?: "above" | "below";
}) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      className={`ui-icon ${className}`}
    >
      {children}
    </button>
  );
}
