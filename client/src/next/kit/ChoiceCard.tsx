import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./ChoiceCard.css";

export interface Choice<V extends string> {
  value: V;
  title: string;
  description: string;
  art?: IconName;
}

/**
 * A few big choices where one must be picked, like "As tabs in one window" or
 * "Each in its own window". Radio buttons underneath, so arrows move between
 * them and screen readers hear a group.
 */
export function ChoiceCards<V extends string>({
  legend,
  name,
  value,
  onChange,
  choices,
  note,
}: {
  legend: string;
  name: string;
  value: V;
  onChange: (value: V) => void;
  choices: Choice<V>[];
  /** A line under the cards. */
  note?: ReactNode;
}) {
  return (
    <fieldset className="k-choices" data-kit="ChoiceCards">
      <legend className="k-choices-legend">{legend}</legend>
      <div className="k-choices-grid">
        {choices.map((choice) => (
          <label key={choice.value} className="k-choice" data-kit="ChoiceCard">
            <input
              type="radio"
              className="k-choice-input"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            {choice.art ? (
              <span className="k-choice-art">
                <Icon name={choice.art} size="lg" />
              </span>
            ) : null}
            <span className="k-choice-text">
              <span className="k-choice-title">{choice.title}</span>
              <span className="k-choice-description">{choice.description}</span>
            </span>
          </label>
        ))}
      </div>
      {note ? <p className="k-choices-note">{note}</p> : null}
    </fieldset>
  );
}
