import { SCALE_OPTIONS } from "../../../lib/interface";
import { HEADINGS } from "../../core/settings";
import { Select, SettingRow, Switch } from "../../kit";
import { Block, Plain } from "./parts";

/** A setting that takes effect at once: its value and how to change it. */
export interface Live<T> {
  value: T;
  onChange: (value: T) => void;
}

export interface AppearanceProps {
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

/** Appearance: how Linger looks on this computer (LOOK-1, LOOK-2, NAME-4). */
export function AppearanceSection({ scale, warmth, plainNames }: AppearanceProps) {
  return (
    <>
      {/* Only when there's something to choose: a heading over nothing would look unfinished. */}
      {warmth ? (
        <Plain>
          <h3 className="nx-set-heading">{HEADINGS.theme}</h3>
          <SettingRow title="Evening warmth" description="Softer colors after sunset." control={<Switch label="Evening warmth" checked={warmth.value} onChange={warmth.onChange} />} />
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
