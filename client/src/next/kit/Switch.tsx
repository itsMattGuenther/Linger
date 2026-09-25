import "./Switch.css";

/**
 * An on/off preference that takes effect at once (SPEC §5.6). A `switch` with
 * a required accessible name; put the visible words beside it with
 * `SettingRow` or your own label.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="k-switch"
      data-kit="Switch"
      data-kit-control=""
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="k-switch-track">
        <span className="k-switch-thumb" />
      </span>
    </button>
  );
}
