import { SCALE_OPTIONS } from "../../../lib/interface";
import type { ThemePref } from "../../../lib/theme";
import { HEADINGS } from "../../core/settings";
import { type Choice, ChoiceCards, Select, SettingRow, Switch } from "../../kit";
import { Block, Plain } from "./parts";

/** A setting that takes effect at once: its value and how to change it. */
export interface Live<T> {
  value: T;
  onChange: (value: T) => void;
}

export interface AppearanceProps {
  /**
   * The color theme, and which themes there are to choose from (LOOK-3).
   * With one choice or none there is nothing to pick, and the block is left out.
   */
  theme?: Live<ThemePref> & { choices: readonly ThemePref[] };
  /** Interface size, a percentage from `SCALE_OPTIONS` (LOOK-1). */
  scale: Live<number>;
  /**
   * Evening warmth (LOOK-2). Left out while the new client's colors have no
   * evening version: a switch that changed nothing would be a broken promise.
   */
  warmth?: Live<boolean>;
  /** Use plain names and message fonts (NAME-4). */
  plainNames: Live<boolean>;
}

const THEME_CHOICES: Record<ThemePref, Choice<ThemePref>> = {
  dark: { value: "dark", title: "Dark", description: "The porch at night.", art: "moon" },
  light: { value: "light", title: "Light", description: "For bright rooms and daylight.", art: "sun" },
  system: { value: "system", title: "System", description: "Follow your desktop's choice.", art: "windows" },
};

/** Appearance: how Linger looks on this computer (LOOK-1 to LOOK-3, NAME-4). */
export function AppearanceSection({ theme, scale, warmth, plainNames }: AppearanceProps) {
  return (
    <>
      {/* Only when there's something to choose: a heading over nothing would look unfinished. */}
      {(theme && theme.choices.length > 1) || warmth ? (
        <Plain>
          {theme && theme.choices.length > 1 ? (
            <ChoiceCards
              legend={HEADINGS.theme}
              compact
              name="theme"
              value={theme.value}
              onChange={theme.onChange}
              choices={theme.choices.map((choice) => THEME_CHOICES[choice])}
            />
          ) : (
            <h3 className="nx-set-heading">{HEADINGS.theme}</h3>
          )}
          {warmth ? (
            <SettingRow title="Evening warmth" description="Softer colors after sunset." control={<Switch label="Evening warmth" checked={warmth.value} onChange={warmth.onChange} />} />
          ) : null}
        </Plain>
      ) : null}
      <Block heading={HEADINGS.size} lead="Text, buttons and windows grow together.">
        <div className="nx-set-size">
          <div className="nx-set-size-preview" aria-hidden="true">
            <span className="nx-set-size-aa">Aa</span>
            <span className="nx-set-size-words">
              <span className="nx-set-size-title">A little room to linger.</span>
              <span className="nx-set-size-sub">This is how your messages will read.</span>
            </span>
          </div>
          <Select
            label="Interface size"
            hideLabel
            value={String(scale.value)}
            onChange={(value) => scale.onChange(Number(value))}
            options={SCALE_OPTIONS.map((size) => ({ value: String(size), label: size === 100 ? "100%, the usual" : `${size}%` }))}
          />
        </div>
      </Block>
      <Plain>
        <h3 className="nx-set-heading">{HEADINGS.names}</h3>
        <SettingRow
          title="Use plain names and message fonts"
          description="Hide custom styles in your view. Everyone else keeps theirs."
          control={<Switch label="Use plain names and message fonts" checked={plainNames.value} onChange={plainNames.onChange} />}
        />
      </Plain>
    </>
  );
}
