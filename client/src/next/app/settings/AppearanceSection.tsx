import { SCALE_OPTIONS, TEXT_SIZE_OPTIONS } from "../../../lib/interface";
import { HEADINGS } from "../../core/settings";
import { Select, SettingRow, Switch } from "../../kit";
import { Block, Note, Plain } from "./parts";

/** A setting that takes effect at once: its value and how to change it. */
export interface Live<T> {
  value: T;
  onChange: (value: T) => void;
}

export interface AppearanceProps {
  /**
   * Interface size, a percentage from `SCALE_OPTIONS` (LOOK-1). Left out on
   * the phone, which has Text size instead (SPEC §4.15), and where the
   * window can't zoom.
   */
  scale?: Live<number>;
  /**
   * The phone's Text size (#690), a percentage from `TEXT_SIZE_OPTIONS`, on
   * top of the phone's own text size. Left out on a computer, which has
   * Interface size.
   */
  textSize?: Live<number>;
  /**
   * Evening warmth (LOOK-2). Left out while the new client's colors have no
   * evening version: a switch that changed nothing would be a broken promise.
   */
  warmth?: Live<boolean>;
  /** Use plain names and message fonts (NAME-4). */
  plainNames: Live<boolean>;
  /**
   * One line per person in the list (#197): more people in the same height,
   * for anybody who wants a quieter list. Left out on the phone, whose list
   * rows are sized for a thumb.
   */
  oneLine?: Live<boolean>;
  /**
   * Show reactions (#485), true unless somebody hid them on this computer.
   * Everybody else still sees theirs.
   */
  reactions?: Live<boolean>;
  /**
   * The choice storage just refused to save (full, or switched off), said
   * under it while the setting stays as it was (#782). Null once one saves.
   */
  unsaved?: AppearanceChoice | null;
}

/** The choices a save can refuse. The phone's Text size never says so: it's kept until the app closes. */
export type AppearanceChoice = "scale" | "plainNames" | "reactions" | "oneLine";

/** Said under a choice storage refused (#782). */
function Unsaved() {
  return <Note tone="problem">Couldn't save that here.</Note>;
}

/** A size's choices, the usual first: "100%, the usual", then each step. */
function sizeOptions(sizes: readonly number[]) {
  return sizes.map((size) => ({ value: String(size), label: size === 100 ? "100%, the usual" : `${size}%` }));
}

/** What a message reads like at the size chosen, beside the choice. */
function SizePreview() {
  return (
    <div className="nx-set-size-preview" aria-hidden="true">
      <span className="nx-set-size-aa">Aa</span>
      <span className="nx-set-size-words">
        <span className="nx-set-size-title">A little room to linger.</span>
        <span className="nx-set-size-sub">This is how your messages will read.</span>
      </span>
    </div>
  );
}

/** Appearance: how Linger looks on this computer or phone (LOOK-1, LOOK-2, NAME-4, #197, #690). */
export function AppearanceSection({ scale, textSize, warmth, plainNames, oneLine, reactions, unsaved = null }: AppearanceProps) {
  return (
    <>
      {/* Only when there's something to choose: a heading over nothing would look unfinished. */}
      {warmth ? (
        <Plain>
          <h3 className="nx-set-heading">{HEADINGS.theme}</h3>
          <SettingRow title="Evening warmth" description="Softer colors after sunset." control={<Switch label="Evening warmth" checked={warmth.value} onChange={warmth.onChange} />} />
        </Plain>
      ) : null}
      {scale ? (
        <Block heading={HEADINGS.size} lead="Text, buttons and windows grow together.">
          <div className="nx-set-size">
            <SizePreview />
            <Select
              label="Interface size"
              hideLabel
              value={String(scale.value)}
              onChange={(value) => scale.onChange(Number(value))}
              options={sizeOptions(SCALE_OPTIONS)}
            />
          </div>
          {unsaved === "scale" ? <Unsaved /> : null}
        </Block>
      ) : null}
      {textSize ? (
        <Block heading={HEADINGS.textSize} lead="Linger's words, on top of your phone's own text size.">
          <div className="nx-set-size">
            <SizePreview />
            <Select
              label="Text size"
              hideLabel
              value={String(textSize.value)}
              onChange={(value) => textSize.onChange(Number(value))}
              options={sizeOptions(TEXT_SIZE_OPTIONS)}
            />
          </div>
        </Block>
      ) : null}
      <Plain>
        <h3 className="nx-set-heading">{HEADINGS.names}</h3>
        <SettingRow
          title="Use plain names and message fonts"
          description="Hide custom styles in your view. Everyone else keeps theirs."
          control={<Switch label="Use plain names and message fonts" checked={plainNames.value} onChange={plainNames.onChange} />}
        />
        {unsaved === "plainNames" ? <Unsaved /> : null}
      </Plain>
      {reactions ? (
        <Plain>
          <h3 className="nx-set-heading">{HEADINGS.reactions}</h3>
          <SettingRow
            title="Show reactions"
            description="Turned off, you see no reactions and no buttons for leaving one. Everyone else still sees theirs."
            control={<Switch label="Show reactions" checked={reactions.value} onChange={reactions.onChange} />}
          />
          {unsaved === "reactions" ? <Unsaved /> : null}
        </Plain>
      ) : null}
      {oneLine ? (
        <Plain>
          <h3 className="nx-set-heading">{HEADINGS.list}</h3>
          <SettingRow
            title="One line per person"
            description="Fits more people in your list. A status shows when you point at someone."
            control={<Switch label="One line per person" checked={oneLine.value} onChange={oneLine.onChange} />}
          />
          {unsaved === "oneLine" ? <Unsaved /> : null}
        </Plain>
      ) : null}
    </>
  );
}
