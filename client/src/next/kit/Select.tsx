import { useId } from "react";
import type { ControlSize } from "./Button";
import { Icon } from "./Icon";
import "./Select.css";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string> {
  /** The label. Always there for assistive technology; `hideLabel` hides it visually. */
  label: string;
  hideLabel?: boolean;
  value: V;
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  size?: ControlSize;
  disabled?: boolean;
  /** Help under the box. */
  hint?: string;
}

/**
 * One choice from a longer list, like an interface size or a microphone: the
 * system's own drop-down in a box of 24, 32 or 40px, labelled like a
 * `TextField`. Short lists of two or three belong in pressed `Button`s or
 * `ChoiceCards` instead, where every choice is in view.
 */
export function Select<V extends string>({ label, hideLabel = false, value, onChange, options, size = "md", disabled = false, hint }: SelectProps<V>) {
  const id = useId();
  const helpId = hint ? `${id}-help` : undefined;
  return (
    <div className="k-select" data-kit="Select">
      <label className="k-select-label" htmlFor={id} data-hidden={hideLabel ? "yes" : undefined}>
        {label}
      </label>
      <span className="k-select-box" data-kit-control="" data-size={size} data-disabled={disabled ? "yes" : undefined}>
        <select
          id={id}
          className="k-select-input"
          value={value}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(event) => {
            const picked = options.find((option) => option.value === event.target.value);
            if (picked) onChange(picked.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="k-select-caret">
          <Icon name="caret" size="sm" />
        </span>
      </span>
      {helpId ? (
        <span id={helpId} className="k-select-help">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
