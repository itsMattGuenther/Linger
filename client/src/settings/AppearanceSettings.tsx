import {
  SCALE_OPTIONS,
  setInterfaceScale,
  useInterfaceScale,
} from "../lib/interface";
import { ActionIcon } from "../lib/icons";
import { THEME_PREFS, type ThemePref } from "../lib/theme";
import PreferenceSwitch from "./PreferenceSwitch";

/** Let readers judge their choices visually without leaving their conversation. */
export default function AppearanceSettings({
  theme,
  onThemeChange,
  warmth,
  onWarmthChange,
  normalize,
  onNormalizeChange,
}: {
  theme: ThemePref;
  onThemeChange: (theme: ThemePref) => void;
  warmth: boolean;
  onWarmthChange: (warmth: boolean) => void;
  normalize: boolean;
  onNormalizeChange: (normalize: boolean) => void;
}) {
  const scale = useInterfaceScale();
  return (
    <div className="appearance-settings">
      <div className="settings-intro">
        <h2>Appearance</h2>
        <p>Make yourself comfortable. These choices stay on this computer.</p>
      </div>
      <section className="settings-section">
        <div className="preference-row scale-row">
          <div className="preference-copy">
            <h3>Interface Size</h3>
            <p>Text, buttons and panels scale together.</p>
          </div>
          <label className="scale-choice">
            <span className="sr-only">Scale</span>
            <select
              className="settings-select"
              value={scale}
              onChange={(event) => {
                const control = event.currentTarget;
                setInterfaceScale(Number(control.value));
                requestAnimationFrame(() =>
                  control.scrollIntoView({ block: "nearest" }),
                );
              }}
            >
              {SCALE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}%{size === 100 ? " — default" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="type-preview" aria-label="Text size preview">
          <span className="type-preview-sample" aria-hidden="true">
            Aa
          </span>
          <div>
            <strong>A little room to linger.</strong>
            <p>This is how your messages will read.</p>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="preference-copy">
          <h3>Color Theme</h3>
          <p>Choose a look, or follow your desktop.</p>
        </div>
        <div className="theme-cards" role="group" aria-label="Color Theme">
          {THEME_PREFS.map((pref) => (
            <button
              type="button"
              key={pref}
              className="theme-card"
              aria-pressed={theme === pref}
              onClick={() => onThemeChange(pref)}
            >
              <span
                className="theme-sample"
                data-choice={pref}
                aria-hidden="true"
              >
                <span className="theme-sample-rail">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-sample-chat">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="theme-card-label">
                {pref === "system"
                  ? "System"
                  : pref === "dark"
                    ? "Dark"
                    : "Light"}
                <span className="theme-choice-mark" aria-hidden="true">
                  {theme === pref ? <ActionIcon name="check" /> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
        <PreferenceSwitch
          label="Evening warmth"
          hint="Softer colors after sunset."
          checked={warmth}
          onChange={onWarmthChange}
        />
      </section>
      <section className="settings-section">
        <PreferenceSwitch
          label="Use plain names and message fonts"
          hint="Hide custom styles in your view. Everyone else keeps theirs."
          checked={normalize}
          onChange={onNormalizeChange}
        />
      </section>
    </div>
  );
}
