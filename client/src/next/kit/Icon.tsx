import { ICON_PATHS, type IconName } from "./icons";
import "./Icon.css";

export type IconSize = "sm" | "md" | "lg";

/**
 * One glyph, always in a fixed square box (12, 16 or 20px) and centered in it.
 *
 * Icons are decoration: the control around them carries the accessible name,
 * so the glyph is hidden from assistive technology. There is no way to size an
 * icon by hand; pick one of the three boxes.
 */
export function Icon({ name, size = "md" }: { name: IconName; size?: IconSize }) {
  return (
    <span className="k-icon" data-kit="Icon" data-size={size} aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        {ICON_PATHS[name]}
      </svg>
    </span>
  );
}

export type { IconName };
