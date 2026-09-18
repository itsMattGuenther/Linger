import { useId } from "react";

/** Pair an immediate preference with a stable label and an explicit state. */
export default function PreferenceSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="preference-row">
      <div className="preference-copy">
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        <p id={`${id}-hint`}>{hint}</p>
      </div>
      <label className="preference-switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track" aria-hidden="true">
          <span />
        </span>
        <span className="switch-state" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
      </label>
    </div>
  );
}
