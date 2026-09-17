/**
 * How your name is drawn (SPEC §4.5) — the AIM feature, with the fiddly parts
 * removed.
 *
 * The thing this replaces is a color wheel. You get sixteen named colors and a
 * click picks one; a gradient is a second click on a second row. There is no
 * hex box, no eyedropper and no saturation square, and contrast safety is not
 * something the form has to police — the palette is built so that every one of
 * the sixteen is readable on both theme backgrounds, so there is nothing here
 * that can produce an unreadable name (SPEC §5.4).
 *
 * Everything is drawn as itself. A face is labelled in its own face, a weight
 * is shown at that weight, and the preview at the top is your display name
 * through exactly the same `nameProps` the stream uses. A picker that describes
 * choices in words instead of showing them is a picker you have to save from to
 * find out what you did.
 *
 * The server validates every key it is sent (AGENTS rule 8). This form is the
 * convenient way to produce a valid one, never the thing that makes it valid.
 */
import { type ReactNode, useEffect, useState } from "react";

import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "../lib/api";
import { FONT_KEYS, FONT_LABELS } from "../lib/fonts";
import { saveStyle } from "../lib/gateway";
import { nameProps } from "../lib/names";
import { PALETTE_KEYS } from "../lib/palette";
import {
  draftOf,
  EFFECTS,
  isDirty,
  previewUser,
  type Slot,
  type StyleDraft,
  styleRequest,
  WEIGHTS,
  withColor,
} from "./style";

/** What each effect is called, and what it is for. */
const EFFECT_WORDS: Record<(typeof EFFECTS)[number], string> = {
  none: "none",
  shimmer: "shimmer",
  glow: "glow",
};

export default function StylePicker({
  api,
  user,
  /** The reader's own settings, which can hide what this is previewing. */
  normalized,
}: {
  api: AuthedApi;
  user: User;
  normalized: boolean;
}) {
  const [draft, setDraft] = useState<StyleDraft>(() => draftOf(user.style));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = isDirty(draft, user.style);

  // Follow a style that changed on another device. Not while this form is
  // mid-edit, for the same reason the display-name box does not.
  // `dirty` is deliberately not a dependency: this follows the saved style, not
  // the draft, and re-running it on every click here would undo the click.
  useEffect(() => {
    if (!dirty) setDraft(draftOf(user.style));
  }, [user.style]);

  const change = (next: StyleDraft): void => {
    setDraft(next);
    setSaved(false);
    setProblem(null);
  };

  const submit = async (): Promise<void> => {
    if (!dirty || busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await saveStyle(api, styleRequest(draft));
      setSaved(true);
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : "Couldn't save how your name looks.",
      );
    } finally {
      setBusy(false);
    }
  };

  const preview = previewUser(user, draft);

  return (
    <section className="settings-section">
      <h3 className="panel-label">how your name looks</h3>
      <p className="settings-lead">
        Preview your name as others will see it.
      </p>

      {/* `name-raw` is the one exception in the app: this draws as itself even
          when the reader has normalized everyone, because
          a preview that obeys your own reading settings is showing you the
          wrong thing. The note below says so out loud. */}
      <p className="style-preview">
        <span {...nameProps(preview, "name-raw style-preview-name")}>
          {user.display_name}
        </span>
      </p>
      {normalized ? (
        <p className="settings-hint meta">
          Plain names are on in Appearance. This preview still shows your style.
        </p>
      ) : null}

      <Fills draft={draft} onChange={change} />

      <Choices label="font">
        {FONT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="style-font"
            style={{ fontFamily: `var(--font-${key})` }}
            aria-pressed={key === draft.fontKey}
            onClick={() => change({ ...draft, fontKey: key })}
          >
            {FONT_LABELS[key]}
          </button>
        ))}
      </Choices>

      <Choices label="weight">
        {WEIGHTS.map((weight) => (
          <button
            key={weight}
            type="button"
            className="style-option"
            style={{ fontWeight: weight }}
            aria-pressed={weight === draft.weight}
            onClick={() => change({ ...draft, weight })}
          >
            {weight}
          </button>
        ))}
        <button
          type="button"
          className="style-option"
          style={{ fontStyle: "italic" }}
          aria-pressed={draft.italic}
          onClick={() => change({ ...draft, italic: !draft.italic })}
        >
          italic
        </button>
      </Choices>

      <Choices label="effect">
        {EFFECTS.map((effect) => (
          <button
            key={effect}
            type="button"
            className="style-option meta"
            aria-pressed={effect === draft.effect}
            onClick={() => change({ ...draft, effect })}
          >
            {EFFECT_WORDS[effect]}
          </button>
        ))}
      </Choices>

      <Choices label="your messages">
        <button
          type="button"
          className="style-font"
          aria-pressed={draft.msgFontKey === null}
          onClick={() => change({ ...draft, msgFontKey: null })}
        >
          the reading face
        </button>
        {FONT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="style-font"
            style={{ fontFamily: `var(--font-${key})` }}
            aria-pressed={key === draft.msgFontKey}
            onClick={() => change({ ...draft, msgFontKey: key })}
          >
            {FONT_LABELS[key]}
          </button>
        ))}
      </Choices>
      <p className="settings-hint meta">
        The face your messages are set in — the only thing you can change about
        the text itself. No colors and no sizes: your name carries who you are,
        and the words stay legible.
      </p>

      {problem === null ? null : (
        <p className="settings-problem" role="alert">
          {problem}
        </p>
      )}
      {saved ? (
        <p className="settings-ok meta" role="status">
          saved
        </p>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          className="settings-save"
          disabled={busy || !dirty}
          onClick={() => void submit()}
        >
          {busy ? "saving…" : "save"}
        </button>
      </div>
    </section>
  );
}

/**
 * The color rows. One for a solid fill, two when it is a gradient — no hidden
 * "which one am I editing" mode, because the whole promise is two clicks and a
 * mode you have to discover is a third.
 */
function Fills({
  draft,
  onChange,
}: {
  draft: StyleDraft;
  onChange: (draft: StyleDraft) => void;
}) {
  return (
    <>
      <Choices label="color">
        <button
          type="button"
          className="style-option meta"
          aria-pressed={!draft.gradient}
          onClick={() => onChange({ ...draft, gradient: false })}
        >
          one color
        </button>
        <button
          type="button"
          className="style-option meta"
          aria-pressed={draft.gradient}
          onClick={() => onChange({ ...draft, gradient: true })}
        >
          two, blended
        </button>
      </Choices>
      <Swatches
        label={draft.gradient ? "from" : ""}
        slot="from"
        chosen={draft.from}
        onPick={(key) => onChange(withColor(draft, "from", key))}
      />
      {draft.gradient ? (
        <Swatches
          label="to"
          slot="to"
          chosen={draft.to}
          onPick={(key) => onChange(withColor(draft, "to", key))}
        />
      ) : null}
    </>
  );
}

/**
 * The sixteen, as a block of eight by two rather than a row that wraps.
 *
 * The label column is the same one every other row here uses, so a gradient's
 * `from` and `to` line up under `color` and read as two answers to one
 * question.
 */
function Swatches({
  label,
  slot,
  chosen,
  onPick,
}: {
  /** Empty for a solid fill: the column stays, the word is not needed. */
  label: string;
  slot: Slot;
  chosen: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="style-row">
      <span className="style-label meta">{label}</span>
      <div
        className="style-swatches"
        role="group"
        aria-label={label === "" ? "name color" : `${label} color`}
      >
        {PALETTE_KEYS.map((key) => (
          <button
            key={`${slot}-${key}`}
            type="button"
            className="style-swatch"
            style={{ background: `var(--name-${key})` }}
            aria-label={key}
            aria-pressed={key === chosen}
            title={key}
            onClick={() => onPick(key)}
          />
        ))}
      </div>
    </div>
  );
}

/** A labelled row of choices. The label is mono metadata; the choices are not. */
function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="style-row">
      <span className="style-label meta">{label}</span>
      <div className="style-choices">{children}</div>
    </div>
  );
}
