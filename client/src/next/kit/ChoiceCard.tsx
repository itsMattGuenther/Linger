import type { ReactNode } from "react";
import type { ThemeId } from "../core/theme";
import { Icon, type IconName } from "./Icon";
import "./ChoiceCard.css";

export interface Choice<V extends string> {
  value: V;
  title: string;
  /** A line under the title; a choice its picture says enough about goes without. */
  description?: string;
  art?: IconName;
  /**
   * A small window drawn in a theme's colors, in place of `art`: the theme's
   * id, put on the picture as `data-theme` (#964, styles/tokens.css), so it
   * shows that theme whatever the page's is.
   */
  theme?: ThemeId;
}

/**
 * A few big choices where one must be picked, like "Beside your list, in one window" or
 * "Each in its own window", or a theme. Radio buttons underneath, so arrows move between
 * them and screen readers hear a group.
 */
export function ChoiceCards<V extends string>({
  legend,
  name,
  value,
  onChange,
  choices,
  note,
  compact = false,
}: {
  legend: string;
  name: string;
  value: V;
  onChange: (value: V) => void;
  choices: Choice<V>[];
  /** A line under the cards. */
  note?: ReactNode;
  /** Short choices, stacked art over words, so three or four fit across. */
  compact?: boolean;
}) {
  return (
    <fieldset className="k-choices" data-kit="ChoiceCards" data-compact={compact ? "yes" : undefined}>
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
            {choice.theme ? (
              <ThemeSample theme={choice.theme} />
            ) : choice.art ? (
              <span className="k-choice-art">
                <Icon name={choice.art} size="lg" />
              </span>
            ) : null}
            <span className="k-choice-text">
              <span className="k-choice-title">{choice.title}</span>
              {choice.description ? <span className="k-choice-description">{choice.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {note ? <p className="k-choices-note">{note}</p> : null}
    </fieldset>
  );
}

/**
 * A theme in miniature (#964): a title bar, then a list with a row lit for
 * something new, a selected row and a plain one, all drawn with the roles
 * inside `data-theme`, so each is that theme's own. A picture only: the
 * choice's title names it.
 */
function ThemeSample({ theme }: { theme: string }) {
  return (
    <span className="k-choice-sample" data-theme={theme} aria-hidden="true">
      <span className="k-choice-sample-bar" />
      <span className="k-choice-sample-row" data-row="lit">
        <span className="k-choice-sample-dot" />
        <span className="k-choice-sample-line" />
      </span>
      <span className="k-choice-sample-row" data-row="selected">
        <span className="k-choice-sample-dot" />
        <span className="k-choice-sample-line" />
      </span>
      <span className="k-choice-sample-row" data-row="plain">
        <span className="k-choice-sample-dot" />
        <span className="k-choice-sample-line" />
      </span>
    </span>
  );
}
