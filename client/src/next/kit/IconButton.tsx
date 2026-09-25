import type { MouseEvent } from "react";
import { ICON_FOR, type ControlSize } from "./Button";
import { Icon, type IconName } from "./Icon";
import { useTooltip } from "./Tooltip";
import "./IconButton.css";

export type IconButtonTone = "plain" | "filled" | "accent" | "danger";

export interface IconButtonProps {
  icon: IconName;
  /** Required: the accessible name, and the tooltip's text. */
  label: string;
  /** A keyboard shortcut shown after the label in the tooltip, like "Esc". */
  shortcut?: string;
  size?: ControlSize;
  tone?: IconButtonTone;
  pressed?: boolean;
  disabled?: boolean;
  /** Take it out of the tab order, for a control keyboard users reach another way. */
  skipTab?: boolean;
  /** For a button that opens something: `aria-expanded`. */
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * A square button with one icon, exactly centered: 24, 32 or 40px.
 *
 * It has no visible text, so `label` is required and becomes both the
 * accessible name and a tooltip on hover and keyboard focus.
 */
export function IconButton({
  icon,
  label,
  shortcut,
  size = "md",
  tone = "plain",
  pressed,
  disabled = false,
  skipTab = false,
  expanded,
  onClick,
}: IconButtonProps) {
  const tip = useTooltip(shortcut ? `${label} · ${shortcut}` : label);
  return (
    <>
      <button
        type="button"
        className="k-icon-button"
        data-kit="IconButton"
        data-kit-control=""
        data-size={size}
        data-tone={tone}
        aria-label={label}
        aria-pressed={pressed}
        aria-expanded={expanded}
        aria-keyshortcuts={shortcut}
        disabled={disabled}
        tabIndex={skipTab ? -1 : undefined}
        onClick={onClick}
        {...tip.anchorProps}
      >
        <Icon name={icon} size={ICON_FOR[size]} />
      </button>
      {tip.bubble}
    </>
  );
}
