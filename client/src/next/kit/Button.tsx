import type { MouseEvent, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ControlSize = "sm" | "md" | "lg";

export interface ButtonProps {
  /** The visible label. It is also the accessible name. */
  children: ReactNode;
  variant?: ButtonVariant;
  /** 24, 32 or 40px tall. There is no other size. */
  size?: ControlSize;
  icon?: IconName;
  /** A toggle: sets `aria-pressed` and draws the selected state. */
  pressed?: boolean;
  /** Working: keeps its width, shows a spinner and refuses clicks. */
  busy?: boolean;
  disabled?: boolean;
  /** Take the parent's full width, for a button that ends a column. */
  fill?: boolean;
  type?: "button" | "submit";
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Icon box per control size, fixed so every button of a size matches. */
export const ICON_FOR: Record<ControlSize, "sm" | "md" | "lg"> = { sm: "sm", md: "md", lg: "lg" };

/**
 * A button with a visible label. Pills, in three heights, four variants.
 *
 * The size is intrinsic: there is no `className` or `style`, so nothing can
 * make a 31px button. Layout (where it sits, whether it fills) belongs to the
 * parent, except `fill`.
 */
export function Button({
  children,
  variant = "secondary",
  size = "md",
  icon,
  pressed,
  busy = false,
  disabled = false,
  fill = false,
  type = "button",
  onClick,
}: ButtonProps) {
  return (
    <button
      type={type}
      className="k-button"
      data-kit="Button"
      data-kit-control=""
      data-variant={variant}
      data-size={size}
      data-fill={fill ? "yes" : undefined}
      data-busy={busy ? "yes" : undefined}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
    >
      {icon && !busy ? <Icon name={icon} size={ICON_FOR[size]} /> : null}
      <span className="k-button-label">{children}</span>
      {busy ? (
        <span className="k-button-busy">
          <Spinner />
        </span>
      ) : null}
    </button>
  );
}
