import { memo } from "react";
import { Button, Icon, IconButton, Spinner } from "../../kit";
import type { ListNote } from "../../core/notes";
import "./ListNotes.css";

/** What the update lines' buttons do (#772). */
export interface UpdateActions {
  /** Restart now, or Update for a copy that needs a password. */
  update: () => void;
  /** The release page for a version. */
  whatsNew: (version: string) => void;
  /** Put an "is out" line off until tomorrow. */
  putOff: (version: string) => void;
  /** Close "You're on Linger …". */
  closeUpdated: () => void;
  /**
   * Why Restart now and Update can't be used right now: in voice or sharing
   * a screen, nothing restarts. Null when they can.
   */
  notNow: string | null;
  /** Updating now: the button waits, and can't be pressed twice. */
  busy: boolean;
}

type Line = Exclude<ListNote, { kind: "update" } | { kind: "release" } | { kind: "updated" } | { kind: "tooold" }>;
type Block = Extract<ListNote, { kind: "update" } | { kind: "release" } | { kind: "updated" }>;
type TooOld = Extract<ListNote, { kind: "tooold" }>;

const isBlock = (note: ListNote): note is Block => note.kind === "update" || note.kind === "release" || note.kind === "updated";
const isTooOld = (note: ListNote): note is TooOld => note.kind === "tooold";

/**
 * The foot's standing lines (decision 1, `core/notes.ts`): a server that
 * can't be reached (with Try now, for one not reached since launch), a
 * computer that can't keep sign-ins, a server you host needing you (with
 * Server settings, #582) or behind (with How to update, #772), servers that
 * need a newer app (#793), and updates (#772): ready, calmly; out, in the
 * lamp, for a copy somebody has to update; and just installed, once. Only
 * while there is something to say; otherwise nothing is drawn at all.
 */
export const ListNotes = memo(function ListNotes({
  notes,
  updates,
  onRetry,
  onHost,
  onHostGuide,
}: {
  notes: readonly ListNote[];
  updates: UpdateActions;
  onRetry?: (server: string) => void;
  onHost?: (server: string) => void;
  /** The host guide's "Updating the server" (#772). */
  onHostGuide?: () => void;
}) {
  if (notes.length === 0) return null;
  const lines = notes.filter((note): note is Line => !isBlock(note) && !isTooOld(note));
  const blocks = notes.filter(isBlock);
  const tooOld = notes.filter(isTooOld);
  return (
    <div className="nx-foot-notes" aria-live="polite" data-screen="list-notes">
      {lines.length > 0 ? (
        <div className="nx-notes">
          {lines.map((note) => (
            <p key={keyOf(note)} className="nx-note" data-note={note.kind} title={"detail" in note && note.detail ? note.detail : undefined}>
              <span className="nx-note-mark">
                {note.kind === "connection" || note.kind === "waiting" ? <Spinner /> : <Icon name={MARK[note.kind]} size="sm" />}
              </span>
              <span className="nx-note-words">{note.words}</span>
              {note.kind === "host" && note.what === "behind" && onHostGuide ? (
                <Button size="sm" onClick={onHostGuide}>
                  How to update
                </Button>
              ) : null}
              {note.kind === "host" && note.what !== "behind" && onHost ? (
                <Button size="sm" onClick={() => onHost(note.server)}>
                  Server settings
                </Button>
              ) : null}
              {note.kind === "waiting" && !note.trying && onRetry ? (
                <Button size="sm" variant="quiet" onClick={() => onRetry(note.server)}>
                  Try now
                </Button>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}
      {tooOld.map((note) => (
        <TooOldBlock key={`${note.kind} ${note.servers.join(" ")}`} note={note} actions={updates} />
      ))}
      {blocks.map((note) => (
        <UpdateBlock key={`${note.kind} ${note.version}`} note={note} actions={updates} />
      ))}
    </div>
  );
});

/**
 * One update line (#772). Ready is calm: it installs by itself, so there's
 * nothing to do. Out and just installed are in the lamp, since they're news
 * (amber means new, docs/design/system.md).
 */
function UpdateBlock({ note, actions }: { note: Block; actions: UpdateActions }) {
  const lit = note.kind !== "update";
  const problem = note.kind === "updated" ? null : note.problem;
  return (
    <div className="nx-update" data-note={note.kind} data-lit={lit ? "yes" : undefined}>
      <span className="nx-note-mark nx-update-mark">
        <Icon name={note.kind === "updated" ? "check" : "download"} size="sm" />
      </span>
      <div className="nx-update-body">
        <p className="nx-update-title">{note.words}</p>
        {note.kind !== "update" && note.line ? <p className="nx-update-line">{note.line}</p> : null}
        {note.kind !== "updated" && note.detail ? <p className="nx-update-line nx-update-muted">{note.detail}</p> : null}
        {problem ? (
          <p className="nx-update-line nx-update-problem" role="alert">
            {`Couldn't update: ${problem}`}
          </p>
        ) : null}
        <div className="nx-update-actions">
          {note.kind === "update" ? (
            <Button size="sm" busy={actions.busy} unavailable={actions.notNow ?? undefined} onClick={actions.update}>
              Restart now
            </Button>
          ) : null}
          {note.kind === "release" && note.password ? (
            <Button size="sm" variant="primary" busy={actions.busy} unavailable={actions.notNow ?? undefined} onClick={actions.update}>
              Update
            </Button>
          ) : null}
          {note.kind !== "update" ? (
            <Button size="sm" onClick={() => actions.whatsNew(note.version)}>
              What's new
            </Button>
          ) : null}
        </div>
      </div>
      {note.kind === "release" ? <IconButton icon="close" label="Not now" size="sm" onClick={() => actions.putOff(note.version)} /> : null}
      {note.kind === "updated" ? <IconButton icon="close" label="Close" size="sm" onClick={actions.closeUpdated} /> : null}
    </div>
  );
}

/**
 * Servers that need a newer app (#793): lit like an update that's out, since
 * it needs doing, with Update now on a copy that installs itself, or how the
 * new one comes. No ×: those servers can't be used until it's updated, so
 * there's nothing to put off. Update now doesn't wait out the day an update
 * otherwise waits, and still never restarts anybody in voice or sharing.
 */
function TooOldBlock({ note, actions }: { note: TooOld; actions: UpdateActions }) {
  return (
    <div className="nx-update" data-note={note.kind} data-lit="yes">
      <span className="nx-note-mark nx-update-mark">
        <Icon name="download" size="sm" />
      </span>
      <div className="nx-update-body">
        <p className="nx-update-title">{note.words}</p>
        <p className="nx-update-line">{note.line}</p>
        {note.detail ? <p className="nx-update-line nx-update-muted">{note.detail}</p> : null}
        {note.problem ? (
          <p className="nx-update-line nx-update-problem" role="alert">
            {`Couldn't update: ${note.problem}`}
          </p>
        ) : null}
        <div className="nx-update-actions">
          {note.button ? (
            <Button size="sm" variant="primary" busy={actions.busy} unavailable={actions.notNow ?? undefined} onClick={actions.update}>
              Update now
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Each line's mark, where it isn't a spinner. */
const MARK = { keyring: "key", host: "house" } as const;

/** One server can have several host lines, so those are told apart by what they're about. */
function keyOf(note: Line): string {
  if (note.kind === "host") return `${note.kind} ${note.server} ${note.what}`;
  return "server" in note ? `${note.kind} ${note.server}` : note.kind;
}
