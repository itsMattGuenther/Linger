import { type MouseEvent, type ReactNode, useId, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";
import { TooltipBubble, useTooltip } from "./Tooltip";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "away";
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
  /**
   * Why it can't be used right now: "Can't knock while Jules is offline." It
   * looks disabled but stays hoverable and reachable by keyboard (a plain
   * `disabled` swallows both). Its label stays its name, and the reason is
   * its tooltip and its description for a screen reader. A press does nothing.
   */
  unavailable?: string;
  /**
   * Something to say about the last press, in the button's own bubble with
   * no hover, and announced: "Three knocks this hour. …" (#288). It's for
   * where there's no room to say it beside the button; the caller takes it
   * away again.
   */
  note?: ReactNode;
  /** Take the parent's full width, for a button that ends a column. */
  fill?: boolean;
  type?: "button" | "submit";
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Icon box per control size, fixed so every button of a size matches. */
export const ICON_FOR: Record<ControlSize, "sm" | "md" | "lg"> = { sm: "sm", md: "md", lg: "lg" };

/**
 * A button with a visible label. Pills, in three heights, five variants.
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
  unavailable,
  note,
  fill = false,
  type = "button",
  onClick,
}: ButtonProps) {
  const why = useId();
  const tip = useTooltip(unavailable);
  const [self, setSelf] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={setSelf}
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
        aria-disabled={unavailable ? true : undefined}
        aria-describedby={unavailable ? why : undefined}
        disabled={disabled && !unavailable}
        onClick={busy || unavailable ? undefined : onClick}
        {...(unavailable ? tip.anchorProps : {})}
      >
        {icon && !busy ? <Icon name={icon} size={ICON_FOR[size]} /> : null}
        <span className="k-button-label">{children}</span>
        {busy ? (
          <span className="k-button-busy">
            <Spinner />
          </span>
        ) : null}
      </button>
      {unavailable ? (
        <span id={why} className="k-sr-only">
          {unavailable}
        </span>
      ) : null}
      {note ? (
        <span className="k-sr-only" role="status">
          {note}
        </span>
      ) : null}
      {note && self ? <TooltipBubble anchor={self}>{note}</TooltipBubble> : unavailable ? tip.bubble : null}
    </>
  );
}
