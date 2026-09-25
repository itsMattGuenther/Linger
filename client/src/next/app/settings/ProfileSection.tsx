import { useEffect, useRef, useState } from "react";
import type { Style } from "../../../generated/Style";
import type { User } from "../../../generated/User";
import type { UserStatus } from "../../../generated/UserStatus";
import { displayNameReady, MAX_DISPLAY_NAME_CHARS } from "../../../lib/account";
import { FONT_KEYS, FONT_LABELS, fontVar, MESSAGE_FONT_KEYS, messageFontVar } from "../../../lib/fonts";
import { draftOf as lookOf, EFFECTS, isDirty as lookChanged, previewUser, type Slot, styleOf, type StyleDraft, WEIGHTS, withColor } from "../../../lib/nameStyle";
import { PALETTE_KEYS } from "../../../lib/palette";
import {
  draftOf,
  FIELDS,
  imageProblem,
  isDirty,
  MAX_FIELD_CHARS,
  MAX_IMAGE_BYTES,
  MAX_LINE_CHARS,
  overLimit,
  type StatusDraft,
  type StatusImage,
  statusOf,
} from "../../../lib/status";
import { HEADINGS, leftOf } from "../../core/settings";
import { Button, Name, Swatch, TextField } from "../../kit";
import { Actions, Block, ChoiceRow, Fields, Note, useSave } from "./parts";

/** What Profile saves. Each resolves to the problem in words, or null once saved. */
export interface ProfileActions {
  /** `PATCH /me` with the display name only. */
  saveName: (name: string) => Promise<string | null>;
  /** The whole status (PROTOCOL §5 replaces it whole). Going away or back follows from its away message. */
  saveStatus: (status: UserStatus) => Promise<string | null>;
  /** Upload a status image as soon as it's picked (PPL-10). */
  uploadImage: (file: File) => Promise<{ image: StatusImage } | { problem: string }>;
  /** An uploaded image this form won't use after all: the server can let it go. */
  dropImage: (id: string) => void;
  /** Your name's style, whole. */
  saveStyle: (style: Style) => Promise<string | null>;
}

export interface ProfileProps {
  me: User;
  /** "Use plain names" is on: the preview says it still shows your style. */
  plainNames: boolean;
  /** A server path as an address this window can load. */
  mediaUrl: (path: string) => string;
  actions: ProfileActions;
}

/** Profile: who you are, what you're up to, and how your name looks (SET-1, PPL-7, NAME-1). */
export function ProfileSection({ me, plainNames, mediaUrl, actions }: ProfileProps) {
  return (
    <>
      <WhoYouAre me={me} saveName={actions.saveName} />
      <YourStatus me={me} mediaUrl={mediaUrl} actions={actions} />
      <YourLook me={me} plainNames={plainNames} saveStyle={actions.saveStyle} />
    </>
  );
}

function WhoYouAre({ me, saveName }: { me: User; saveName: ProfileActions["saveName"] }) {
  const [name, setName] = useState(me.display_name);
  const save = useSave();
  const dirty = name.trim() !== me.display_name;
  // Follow a name changed elsewhere, but never under somebody's typing.
  useEffect(() => {
    if (!dirty) setName(me.display_name);
    // `dirty` is left out on purpose: this follows the saved name, not the box.
  }, [me.display_name]);
  const ready = displayNameReady(name, me.display_name) && save.phase.kind !== "saving";
  const submit = () => {
    if (ready) void save.run(saveName(name.trim()));
  };
  return (
    <Block heading={HEADINGS.who}>
      <Fields>
        <TextField
          label="Display name"
          value={name}
          maxLength={MAX_DISPLAY_NAME_CHARS}
          hint="How your name reads on this server."
          onChange={(next) => {
            setName(next);
            save.reset();
          }}
          onEnter={submit}
        />
        <TextField label="Username" value={me.username} onChange={() => undefined} readOnly mono hint={`People mention you with @${me.username}. It never changes.`} />
      </Fields>
      <Actions phase={save.phase}>
        <Button variant="primary" disabled={!ready} busy={save.phase.kind === "saving"} onClick={submit}>
          Save name
        </Button>
      </Actions>
    </Block>
  );
}

function YourStatus({ me, mediaUrl, actions }: { me: User; mediaUrl: (path: string) => string; actions: ProfileActions }) {
  const saved = me.status ?? null;
  const [draft, setDraft] = useState<StatusDraft>(() => draftOf(saved));
  const [uploading, setUploading] = useState(false);
  const save = useSave();
  const picker = useRef<HTMLInputElement | null>(null);
  // Images uploaded in this sitting and not saved to anything yet: taken back
  // when replaced, removed, reset or left behind (PPL-10).
  const unsaved = useRef<Set<string>>(new Set());
  const dirty = isDirty(draft, saved);

  useEffect(() => {
    if (!dirty) setDraft(draftOf(saved));
    // Follows the saved status, not the draft (as the name does).
  }, [saved]);

  const drop = actions.dropImage;
  useEffect(
    () => () => {
      for (const id of unsaved.current) drop(id);
      unsaved.current.clear();
    },
    [drop],
  );

  const letGo = (image: StatusImage | null) => {
    if (image && unsaved.current.delete(image.id)) drop(image.id);
  };
  const edit = (change: Partial<StatusDraft>) => {
    setDraft((held) => ({ ...held, ...change }));
    save.reset();
  };
  const setImage = (next: StatusImage | null) => {
    letGo(draft.image);
    edit({ image: next });
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    const refusal = imageProblem(file);
    if (refusal) {
      save.fail(refusal);
      return;
    }
    save.reset();
    setUploading(true);
    void actions.uploadImage(file).then((result) => {
      setUploading(false);
      if ("problem" in result) {
        save.fail(result.problem);
        return;
      }
      unsaved.current.add(result.image.id);
      setImage(result.image);
    });
  };

  const commit = async (next: StatusDraft) => {
    const ok = await save.run(actions.saveStatus(statusOf(next, saved)));
    // Saved: the image is named by a status now, and not ours to take back.
    if (ok) unsaved.current.clear();
  };

  const tooLong = overLimit(draft);
  const away = (saved?.away_message ?? "") !== "";
  const busy = save.phase.kind === "saving";

  return (
    <Block heading={HEADINGS.status} lead="Let people know what you're up to. It shows under your name in everyone's list.">
      {away ? (
        <div className="nx-set-away">
          <p className="nx-set-away-words">
            You're away: <span className="nx-set-away-message">{saved?.away_message}</span>
          </p>
          <Button size="sm" icon="sun" disabled={busy} onClick={() => void commit({ ...draft, awayMessage: "" })}>
            I'm back
          </Button>
        </div>
      ) : null}
      <TextField
        label="Status"
        value={draft.line}
        italic
        placeholder="What are you up to?"
        hint={leftOf(draft.line, MAX_LINE_CHARS, 40) ?? "One line, in your own styling."}
        error={overBy(draft.line, MAX_LINE_CHARS)}
        onChange={(line) => edit({ line })}
      />
      <Fields columns={3}>
        {FIELDS.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            value={draft[field.key]}
            maxLength={MAX_FIELD_CHARS}
            placeholder={PLACEHOLDERS[field.key]}
            hint={leftOf(draft[field.key], MAX_FIELD_CHARS, 20) ?? undefined}
            onChange={(value) => edit({ [field.key]: value })}
          />
        ))}
      </Fields>
      <div className="nx-set-image">
        <span className="nx-set-image-text">
          <span className="nx-set-image-title">Image</span>
          <span className="nx-set-image-hint">
            One picture on your status card. Up to {MAX_IMAGE_BYTES / 1024} KB, shown at 400 × 200.
          </span>
        </span>
        <span className="nx-set-image-buttons">
          {draft.image ? (
            <Button size="sm" variant="quiet" disabled={busy || uploading} onClick={() => setImage(null)}>
              Remove
            </Button>
          ) : null}
          <Button size="sm" icon="media" busy={uploading} disabled={busy} onClick={() => picker.current?.click()}>
            {draft.image ? "Replace" : "Add an image"}
          </Button>
        </span>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          aria-label="Choose a status image"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {draft.image ? <img className="nx-set-image-shown" src={mediaUrl(draft.image.url)} alt="The image on your status" /> : null}
      <TextField
        label="Away message"
        value={draft.awayMessage}
        italic
        placeholder="back after work"
        hint={leftOf(draft.awayMessage, MAX_LINE_CHARS, 40) ?? "Setting one makes you away, and it shows instead of your status. The Away button in your list does the same."}
        error={overBy(draft.awayMessage, MAX_LINE_CHARS)}
        onChange={(awayMessage) => edit({ awayMessage })}
      />
      <Actions phase={tooLong ? { kind: "problem", words: tooLong } : save.phase}>
        {dirty ? (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              letGo(draft.image);
              setDraft(draftOf(saved));
              save.reset();
            }}
          >
            Reset
          </Button>
        ) : null}
        <Button variant="primary" disabled={!dirty || tooLong !== null || uploading} busy={busy} onClick={() => void commit(draft)}>
          Save status
        </Button>
      </Actions>
    </Block>
  );
}

/** "12 over", for a field past its limit; nothing while it fits. */
function overBy(value: string, max: number): string | undefined {
  return [...value.trim()].length > max ? (leftOf(value, max, 0) ?? undefined) : undefined;
}

const PLACEHOLDERS: Record<(typeof FIELDS)[number]["key"], string> = {
  reading: "a book, an article",
  listening: "a record, a show",
  workingOn: "a project",
};

const WEIGHT_WORDS: Record<(typeof WEIGHTS)[number], string> = { 400: "Regular", 500: "Medium", 700: "Bold" };
const EFFECT_WORDS: Record<(typeof EFFECTS)[number], string> = { none: "None", shimmer: "Shimmer", glow: "Glow" };

function YourLook({ me, plainNames, saveStyle }: { me: User; plainNames: boolean; saveStyle: ProfileActions["saveStyle"] }) {
  const [draft, setDraft] = useState<StyleDraft>(() => lookOf(me.style));
  const save = useSave();
  const dirty = lookChanged(draft, me.style);

  useEffect(() => {
    if (!dirty) setDraft(lookOf(me.style));
    // Follows the saved style, not the draft.
  }, [me.style]);

  const change = (next: StyleDraft) => {
    setDraft(next);
    save.reset();
  };
  const swatches = (slot: Slot) => (
    <div className="nx-set-swatches">
      {PALETTE_KEYS.map((key) => (
        <Swatch key={key} colorKey={key} label={key} pressed={draft[slot] === key} onClick={() => change(withColor(draft, slot, key))} />
      ))}
    </div>
  );
  const preview = previewUser(me, draft);

  return (
    <Block heading={HEADINGS.look} lead="Your name, your colors. Try a look before you save it.">
      <div className="nx-set-preview" aria-label="Preview of your name">
        <span className="nx-set-preview-top">
          <Name person={preview} size="display" raw />
          <span className="nx-set-preview-note">Preview · only you can see this</span>
        </span>
        <p className="nx-set-preview-message" style={{ fontFamily: messageFontVar(draft.msgFontKey) }}>
          There you are. I saved you a seat.
        </p>
      </div>
      {plainNames ? <Note>Plain names are on in Appearance. This preview still shows your style.</Note> : null}
      <div className="nx-set-look">
        <ChoiceRow label="Font">
          {FONT_KEYS.map((key) => (
            <Button key={key} size="sm" pressed={draft.fontKey === key} onClick={() => change({ ...draft, fontKey: key })}>
              <span style={{ fontFamily: fontVar(key, "var(--font-ui)") }}>{FONT_LABELS[key]}</span>
            </Button>
          ))}
        </ChoiceRow>
        <ChoiceRow label="Weight">
          {WEIGHTS.map((weight) => (
            <Button key={weight} size="sm" pressed={draft.weight === weight} onClick={() => change({ ...draft, weight })}>
              <span style={{ fontWeight: weight }}>{WEIGHT_WORDS[weight]}</span>
            </Button>
          ))}
          <Button size="sm" pressed={draft.italic} onClick={() => change({ ...draft, italic: !draft.italic })}>
            <span className="nx-set-italic">Italic</span>
          </Button>
        </ChoiceRow>
        <ChoiceRow label="Color">
          <Button size="sm" pressed={!draft.gradient} onClick={() => change({ ...draft, gradient: false })}>
            One color
          </Button>
          <Button size="sm" pressed={draft.gradient} onClick={() => change({ ...draft, gradient: true })}>
            Two, blended
          </Button>
        </ChoiceRow>
        <ChoiceRow label={draft.gradient ? "From" : "Name color"}>{swatches("from")}</ChoiceRow>
        {draft.gradient ? <ChoiceRow label="To">{swatches("to")}</ChoiceRow> : null}
        <ChoiceRow label="Effect">
          {EFFECTS.map((effect) => (
            <Button key={effect} size="sm" pressed={draft.effect === effect} onClick={() => change({ ...draft, effect })}>
              {EFFECT_WORDS[effect]}
            </Button>
          ))}
        </ChoiceRow>
        <ChoiceRow label="Your messages">
          <Button size="sm" pressed={draft.msgFontKey === null} onClick={() => change({ ...draft, msgFontKey: null })}>
            The reading face
          </Button>
          {MESSAGE_FONT_KEYS.map((key) => (
            <Button key={key} size="sm" pressed={draft.msgFontKey === key} onClick={() => change({ ...draft, msgFontKey: key })}>
              <span style={{ fontFamily: fontVar(key, "var(--font-ui)") }}>{FONT_LABELS[key]}</span>
            </Button>
          ))}
        </ChoiceRow>
      </div>
      <Note>The face your messages are set in is the only thing you can change about the text itself. Your name carries who you are, and the words stay easy to read.</Note>
      <Actions phase={save.phase}>
        {dirty ? (
          <Button
            variant="quiet"
            disabled={save.phase.kind === "saving"}
            onClick={() => {
              setDraft(lookOf(me.style));
              save.reset();
            }}
          >
            Reset changes
          </Button>
        ) : null}
        <Button variant="primary" disabled={!dirty} busy={save.phase.kind === "saving"} onClick={() => void save.run(saveStyle(styleOf(draft)))}>
          Save your look
        </Button>
      </Actions>
    </Block>
  );
}
