import type { ReactNode } from "react";
import { Icon } from "./Icon";
import "./Checkbox.css";

/**
 * One of several choices that are each on or off together, like the servers
 * an away message shows on. A real checkbox, so it is announced and toggled
 * the usual way; the words beside it are its name, and clicking them toggles
 * it too. A 32px row, drawn by the kit, with the focus ring around the row.
 */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** What it's for, shown beside it and read as its name. */
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="k-check" data-kit="Checkbox" data-kit-control="" data-disabled={disabled ? "yes" : undefined}>
      <input
        type="checkbox"
        className="k-check-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="k-check-box" aria-hidden="true">
        {checked ? <Icon name="check" size="sm" /> : null}
      </span>
      <span className="k-check-text">{children}</span>
    </label>
  );
}
