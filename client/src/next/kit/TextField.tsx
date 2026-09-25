import { type ChangeEvent, type PointerEvent, useId, useRef } from "react";
import type { ControlSize } from "./Button";
import { Icon, type IconName } from "./Icon";
import "./TextField.css";

export interface TextFieldProps {
  /** The label. Always there for assistive technology; `hideLabel` hides it visually. */
  label: string;
  hideLabel?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: ControlSize;
  type?: "text" | "search" | "password";
  /** A glyph before the text, like the search lens. */
  icon?: IconName;
  /** Statuses and away messages are written in italic. */
  italic?: boolean;
  /** Codes and addresses. */
  mono?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  /** Help under the field. */
  hint?: string;
  /** What's wrong, in words. Marks the field invalid. */
  error?: string;
  maxLength?: number;
  autoFocus?: boolean;
  onEnter?: () => void;
}

/**
 * A single-line text field: a label, a box in one of the three heights, and
 * optional help or an error in words under it.
 */
export function TextField({
  label,
  hideLabel = false,
  value,
  onChange,
  placeholder,
  size = "md",
  type = "text",
  icon,
  italic = false,
  mono = false,
  readOnly = false,
  disabled = false,
  hint,
  error,
  maxLength,
  autoFocus,
  onEnter,
}: TextFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  // The whole box is the target: a press on its padding focuses the input.
  const focusFromBox = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.target !== input.current && !disabled) {
      event.preventDefault();
      input.current?.focus();
    }
  };
  const helpId = hint || error ? `${id}-help` : undefined;
  return (
    <div className="k-field" data-kit="TextField">
      <label className="k-field-label" htmlFor={id} data-hidden={hideLabel ? "yes" : undefined}>
        {label}
      </label>
      <span
        className="k-field-box"
        data-kit-control=""
        data-size={size}
        data-invalid={error ? "yes" : undefined}
        data-readonly={readOnly ? "yes" : undefined}
        onPointerDown={focusFromBox}
      >
        {icon ? <Icon name={icon} size="sm" /> : null}
        <input
          ref={input}
          id={id}
          className="k-field-input"
          type={type}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          disabled={disabled}
          maxLength={maxLength}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={helpId}
          data-italic={italic ? "yes" : undefined}
          data-mono={mono ? "yes" : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
        />
      </span>
      {helpId ? (
        <span id={helpId} className="k-field-help" data-error={error ? "yes" : undefined}>
          {error ?? hint}
        </span>
      ) : null}
    </div>
  );
}
