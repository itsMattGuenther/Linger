import { SCALE_OPTIONS, TEXT_SIZE_OPTIONS } from "../../../lib/interface";
import { type AppIconShell, ICON_LOOKS, type IconLook } from "../../core/appIcon";
import { HEADINGS } from "../../core/settings";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Select, SettingRow, Switch } from "../../kit";
import { Block, Note, Plain } from "./parts";

/** A setting that takes effect at once: its value and how to change it. */
export interface Live<T> {
  value: T;
  onChange: (value: T) => void;
}

export interface AppearanceProps {
  /**
   * The phone's home screen icon (#961): the look on it now, how to change
   * it, and which phone, for the icons' shape and what a change does. Left
   * out on a computer, and until the phone has said which look it shows.
   */
  appIcon?: Live<IconLook> & {
    phone: AppIconShell["phone"];
    /** The phone didn't make the last change, said under the looks. */
    refused?: boolean;
  };
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

/** Each look's picture: what scripts/app-icons.mjs makes the phones' icons from. */
const PICTURES: Record<IconLook, string> = {
  door: new URL("./app-icons/door.png", import.meta.url).href,
  "after-dark": new URL("./app-icons/after-dark.png", import.meta.url).href,
  "porch-light": new URL("./app-icons/porch-light.png", import.meta.url).href,
  daylight: new URL("./app-icons/daylight.png", import.meta.url).href,
  dusk: new URL("./app-icons/dusk.png", import.meta.url).href,
  original: new URL("./app-icons/original.png", import.meta.url).href,
};

/**
 * The home screen icon (#961): each look in the phone's own shape, the one in
 * use picked to start. Picking only chooses, so arrow keys can look through
 * them; Use this icon is what changes it, which on Android may close Linger.
 * Radio buttons underneath, so arrows move between them and a screen reader
 * hears a group.
 */
function IconPicker({ value, onChange, phone, refused, children }: NonNullable<AppearanceProps["appIcon"]> & { children: ReactNode }) {
  const [picked, setPicked] = useState<IconLook>(value);
  // The look in use moves the choice with it, unless the person had already
  // chosen another meanwhile.
  const shown = useRef(value);
  useEffect(() => {
    setPicked((now) => (now === shown.current ? value : now));
    shown.current = value;
  }, [value]);
  return (
    <>
      <div className="nx-set-icons" role="radiogroup" aria-label="App icon" data-phone={phone}>
        {ICON_LOOKS.map((look) => (
          <label key={look.id} className="nx-set-icon">
            <input type="radio" className="nx-set-icon-input" name="app-icon" value={look.id} checked={picked === look.id} onChange={() => setPicked(look.id)} />
            <img className="nx-set-icon-picture" src={PICTURES[look.id]} alt="" draggable={false} />
            <span className="nx-set-icon-name">{look.name}</span>
          </label>
        ))}
      </div>
      {children}
      {refused ? <Note tone="problem">Your phone didn't change the icon.</Note> : null}
      <div>
        <Button variant="primary" disabled={picked === value} onClick={() => onChange(picked)}>
          Use this icon
        </Button>
      </div>
    </>
  );
}

/** Appearance: how Linger looks on this computer or phone (LOOK-1, LOOK-2, NAME-4, #197, #690, #961). */
export function AppearanceSection({ appIcon, scale, textSize, warmth, plainNames, oneLine, reactions, unsaved = null }: AppearanceProps) {
  return (
    <>
      {appIcon ? (
        <Block heading={HEADINGS.appIcon} lead={appIcon.phone === "iphone" ? "The icon on your Home Screen." : "The icon on your home screen."}>
          <IconPicker {...appIcon}>
            {appIcon.phone === "iphone" ? (
              <Note>Your iPhone confirms each change with a short message.</Note>
            ) : (
              <>
                <Note>The first time you change it, Linger closes, and leaves a call you're in. Open it again from your home screen.</Note>
                <Note>Or turn on Themed icons in your phone's Wallpaper &amp; style, and the door takes your wallpaper's colors.</Note>
              </>
            )}
          </IconPicker>
        </Block>
      ) : null}
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
