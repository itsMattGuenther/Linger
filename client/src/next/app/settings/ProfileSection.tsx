import { useEffect, useId, useRef, useState } from "react";
import type { Style } from "../../../generated/Style";
import type { User } from "../../../generated/User";
import type { UserStatus } from "../../../generated/UserStatus";
import { displayNameProblem, displayNameReady, MAX_DISPLAY_NAME_CHARS, type NameSaid } from "../../../lib/account";
import { FONT_KEYS, FONT_LABELS, fontVar, MESSAGE_FONT_KEYS, messageFontVar } from "../../../lib/fonts";
import { deviceTimeZone, LOCAL_TIME_NEEDS_UPDATE } from "../../../lib/localTime";
import { draftOf as lookOf, EFFECTS, isDirty as lookChanged, previewUser, type Slot, styleOf, type StyleDraft, WEIGHTS, withColor } from "../../../lib/nameStyle";
import { PALETTE_KEYS } from "../../../lib/palette";
import { MAX_FIELD_CHARS, MAX_LABEL_CHARS, MAX_LINE_CHARS, SUGGESTED_LABELS } from "../../../lib/status";
import { onPhone } from "../../core/phone";
import { HEADINGS, leftOf } from "../../core/settings";
import { draftOf, type FieldRow, isDirty, type LabelChoice, labelOf, OWN, problemOf, type StatusDraft, statusOf, type SuggestedLabel } from "../../core/status";
import { Button, IconButton, Name, Select, SettingRow, Swatch, Switch, TextField } from "../../kit";
import { useTheirTime } from "../useTheirTime";
import { Actions, Block, ChoiceRow, Fields, Note, Plain, useFollowSaved, useSave } from "./parts";

/** What Profile saves. Each resolves to the problem in words, or null once saved. */
export interface ProfileActions {
  /** `PATCH /me` with the display name only. A name that looks like somebody's here (#574) is said on the field. */
  saveName: (name: string) => Promise<NameSaid>;
  /** The whole status (PROTOCOL §5 replaces it whole). Going away or back follows from its away message. */
  saveStatus: (status: UserStatus) => Promise<string | null>;
  /** Your name's style, whole. */
  saveStyle: (style: Style) => Promise<string | null>;
  /** "Show my local time" (#604): a zone name turns it on, "" turns it off. */
  saveTimeZone: (zone: string) => Promise<string | null>;
}

export interface ProfileProps {
  me: User;
  /** "Use plain names" is on: the preview says it still shows your style. */
  plainNames: boolean;
  actions: ProfileActions;
  /** The host's guide to updating the server, for a server too old for something here (#640). Nobody else has it. */
  openGuide?: () => void;
}

/** Profile: who you are, what you're up to, and how your name looks (SET-1, PPL-7, NAME-1). */
export function ProfileSection({ me, plainNames, actions, openGuide }: ProfileProps) {
  return (
    <>
      <WhoYouAre me={me} saveName={actions.saveName} />
      <YourStatus me={me} saveStatus={actions.saveStatus} />
      <YourClock me={me} saveTimeZone={actions.saveTimeZone} openGuide={openGuide} />
      <YourLook me={me} plainNames={plainNames} saveStyle={actions.saveStyle} />
    </>
  );
}

function WhoYouAre({ me, saveName }: { me: User; saveName: ProfileActions["saveName"] }) {
  const [name, setName] = useState(me.display_name);
  const save = useSave();
  // The server's word that this name looks like somebody's here (#574), until it's changed.
  const [onName, setOnName] = useState<string | null>(null);
  const dirty = name.trim() !== me.display_name;
  // Follow a name changed elsewhere, but never under somebody's typing.
  useFollowSaved(me.display_name, setName, (held, saved) => held.trim() !== saved, (saved) => saved);
  const ready = displayNameReady(name, me.display_name) && onName === null && save.phase.kind !== "saving";
  const submit = () => {
    if (!ready) return;
    const said = saveName(name.trim()).then((answer) => {
      if (answer === null || typeof answer === "string") return answer;
      setOnName(answer.onName);
      return answer.onName;
    });
    void save.run(said);
  };
  return (
    <Block heading={HEADINGS.who}>
      <Fields>
        <TextField
          label="Display name"
          value={name}
          maxLength={MAX_DISPLAY_NAME_CHARS}
          hint="How your name reads on this server."
          // Only once it's changed: a name saved before the rules (#296) stays as it is.
          error={dirty ? (displayNameProblem(name) ?? onName ?? undefined) : undefined}
          onChange={(next) => {
            setName(next);
            setOnName(null);
            save.reset();
          }}
          onEnter={submit}
        />
        <TextField label="Username" value={me.username} onChange={() => undefined} readOnly mono hint={`People mention you by typing @ and your name, and it goes in as @${me.username}. Your username never changes.`} />
      </Fields>
      {/* Said on the field instead, not twice. */}
      <Actions phase={onName === null ? save.phase : undefined}>
        <Button variant="primary" disabled={!ready} busy={save.phase.kind === "saving"} onClick={submit}>
          Save name
        </Button>
      </Actions>
    </Block>
  );
}

function YourStatus({ me, saveStatus }: { me: User; saveStatus: ProfileActions["saveStatus"] }) {
  const saved = me.status ?? null;
  const [draft, setDraft] = useState<StatusDraft>(() => draftOf(saved));
  const save = useSave();
  const dirty = isDirty(draft, saved);

  useFollowSaved(saved, setDraft, isDirty, draftOf);

  const edit = (change: Partial<StatusDraft>) => {
    setDraft((held) => ({ ...held, ...change }));
    save.reset();
  };
  const editRow = (at: number, row: FieldRow) => {
    setDraft((held) => ({ ...held, rows: held.rows.map((other, index) => (index === at ? row : other)) }));
    save.reset();
  };

  const commit = (next: StatusDraft) => save.run(saveStatus(statusOf(next, saved)));

  const tooLong = problemOf(draft);
  const away = (saved?.away_message ?? "") !== "";
  const busy = save.phase.kind === "saving";

  return (
    <Block heading={HEADINGS.status} lead="Let people know what you're up to. It shows under your name in everyone's list.">
      {away ? (
        <div className="nx-set-away">
          <p className="nx-set-away-words">
            You're away: <span className="nx-set-away-message">{saved?.away_message}</span>
          </p>
          <Button size="sm" variant="away" icon="sun" disabled={busy} onClick={() => void commit({ ...draft, awayMessage: "" })}>
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
      <StatusFields rows={draft.rows} onChange={editRow} />
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
              setDraft(draftOf(saved));
              save.reset();
            }}
          >
            Reset
          </Button>
        ) : null}
        <Button variant="primary" disabled={!dirty || tooLong !== null} busy={busy} onClick={() => void commit(draft)}>
          Save status
        </Button>
      </Actions>
    </Block>
  );
}

const SHOW_TIME = "Show my local time";

/**
 * "Show my local time" (#604, SPEC §4.6): your card says what time it is
 * where you are. Off to start, because a time zone says roughly where
 * somebody lives. It takes effect at once, like every switch (SPEC §5.6),
 * and follows this computer's clock. On a server too old to keep it (#640),
 * it stays off and says so, with the host's way to update it.
 */
function YourClock({ me, saveTimeZone, openGuide }: { me: User; saveTimeZone: ProfileActions["saveTimeZone"]; openGuide: (() => void) | undefined }) {
  const here = deviceTimeZone();
  const on = (me.time_zone ?? null) !== null;
  const shown = useTheirTime(me);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (next: boolean) => {
    const zone = next ? here : "";
    if (zone === null) return;
    setChanging(true);
    setProblem(null);
    void saveTimeZone(zone).then((said) => {
      setChanging(false);
      setProblem(said);
    });
  };
  const device = onPhone() ? "phone" : "computer";
  const description = on
    ? `Friends see ${shown === null ? "your time" : `“${shown}”`} on your card. It follows this ${device}'s clock.`
    : here === null
      ? `This ${device} doesn't say which time zone it's in, so there's no time to show.`
      : "Your card says what time it is where you are, so nobody knocks at 3 AM by mistake. It tells friends roughly where you are, so it's off until you turn it on.";
  return (
    <Plain>
      <h3 className="nx-set-heading">{HEADINGS.clock}</h3>
      <SettingRow
        title={SHOW_TIME}
        description={description}
        control={<Switch label={SHOW_TIME} checked={on} disabled={changing || (!on && here === null)} onChange={set} />}
      />
      {problem ? <Note tone="problem">{problem}</Note> : null}
      {problem === LOCAL_TIME_NEEDS_UPDATE && openGuide ? (
        <Actions start>
          <Button icon="go" onClick={openGuide}>
            How to update
          </Button>
        </Actions>
      ) : null}
    </Plain>
  );
}

/** "12 over", for a field past its limit; nothing while it fits. */
function overBy(value: string, max: number): string | undefined {
  return [...value.trim()].length > max ? (leftOf(value, max, 0) ?? undefined) : undefined;
}

/** What each suggested label's box offers before anything is typed. */
const PLACEHOLDERS: Record<SuggestedLabel, string> = {
  "Listening to": "a record, a show",
  Reading: "a book, an article",
  "Working on": "a project",
  Playing: "a game",
  Watching: "a film, a series",
};

const ORDINALS = ["First", "Second", "Third"] as const;

const LABEL_OPTIONS: readonly { value: LabelChoice; label: string }[] = [...SUGGESTED_LABELS.map((label) => ({ value: label, label })), { value: OWN, label: "Your own…" }];

/**
 * The three short fields (#270): each a label and what it says. The label is
 * picked from the suggestions or typed ("Your own…" turns the drop-down into
 * a box, with the list a click away). A web address in what it says opens
 * when somebody clicks it on your card.
 */
function StatusFields({ rows, onChange }: { rows: readonly FieldRow[]; onChange: (at: number, row: FieldRow) => void }) {
  const id = useId();
  return (
    <div className="nx-set-status-fields" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
      <span id={`${id}-label`} className="nx-set-group-label">
        Fields
      </span>
      <div className="nx-set-status-rows">
        {rows.map((row, at) => (
          <StatusFieldRow key={at} at={at} row={row} rows={rows} onChange={(next) => onChange(at, next)} />
        ))}
      </div>
      <p id={`${id}-help`} className="nx-set-note">
        Pick a label or type your own. A web address, like github.com/you, opens when somebody clicks it on your card.
      </p>
    </div>
  );
}

function StatusFieldRow({ at, row, rows, onChange }: { at: number; row: FieldRow; rows: readonly FieldRow[]; onChange: (row: FieldRow) => void }) {
  const cell = useRef<HTMLDivElement | null>(null);
  // Focus follows a switch between the list and your own box, and only a
  // switch: opening Profile on a typed label doesn't take the focus.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!moved) return;
    cell.current?.querySelector<HTMLElement>("input, select")?.focus();
    setMoved(false);
  }, [moved]);

  const ordinal = ORDINALS[at] ?? "Another";
  const labelName = `${ordinal} field's label`;
  const label = labelOf(row);
  const pick = (choice: LabelChoice) => {
    onChange({ ...row, choice });
    if (choice === OWN) setMoved(true);
  };
  // Back to the list: the first suggestion no other field is using.
  const backToList = () => {
    const taken = new Set(rows.filter((_, index) => index !== at).map((other) => labelOf(other)));
    const free = SUGGESTED_LABELS.find((suggestion) => !taken.has(suggestion)) ?? SUGGESTED_LABELS[0];
    onChange({ ...row, choice: free });
    setMoved(true);
  };

  return (
    <div className="nx-set-status-field">
      <div className="nx-set-status-label" ref={cell}>
        {row.choice === OWN ? (
          <>
            <TextField label={labelName} hideLabel value={row.own} maxLength={MAX_LABEL_CHARS} placeholder="Your own label" onChange={(own) => onChange({ ...row, own })} />
            <IconButton icon="caret" tone="filled" label="Pick a label from the list" onClick={backToList} />
          </>
        ) : (
          <Select label={labelName} hideLabel value={row.choice} options={LABEL_OPTIONS} onChange={pick} />
        )}
      </div>
      <TextField
        label={label || `${ordinal} field`}
        hideLabel
        value={row.value}
        maxLength={MAX_FIELD_CHARS}
        placeholder={row.choice === OWN ? "a few words, or a link" : PLACEHOLDERS[row.choice]}
        hint={leftOf(row.value, MAX_FIELD_CHARS, 20) ?? undefined}
        onChange={(value) => onChange({ ...row, value })}
      />
    </div>
  );
}

const WEIGHT_WORDS: Record<(typeof WEIGHTS)[number], string> = { 400: "Regular", 500: "Medium", 700: "Bold" };
const EFFECT_WORDS: Record<(typeof EFFECTS)[number], string> = { none: "None", shimmer: "Shimmer", glow: "Glow" };

function YourLook({ me, plainNames, saveStyle }: { me: User; plainNames: boolean; saveStyle: ProfileActions["saveStyle"] }) {
  const [draft, setDraft] = useState<StyleDraft>(() => lookOf(me.style));
  const save = useSave();
  const dirty = lookChanged(draft, me.style);

  useFollowSaved(me.style, setDraft, lookChanged, lookOf);

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
