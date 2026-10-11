import { Button, Icon, Spinner } from "../../kit";
import type { ListNote } from "../../core/notes";
import "./ListNotes.css";

/**
 * The foot's standing lines (decision 1, `core/notes.ts`): a server that
 * can't be reached (with Try now, for one not reached since launch), a
 * computer that can't keep sign-ins, a server you host needing you (with
 * Hosting…, #582), a new version. Only while there is something to say;
 * otherwise nothing is drawn at all.
 */
export function ListNotes({
  notes,
  onUpdate,
  onRetry,
  onHost,
}: {
  notes: readonly ListNote[];
  onUpdate: () => void;
  onRetry?: (server: string) => void;
  onHost?: (server: string) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="nx-notes" aria-live="polite" data-screen="list-notes">
      {notes.map((note) => (
        <p key={keyOf(note)} className="nx-note" data-note={note.kind} title={"detail" in note && note.detail ? note.detail : undefined}>
          <span className="nx-note-mark">
            {note.kind === "connection" || note.kind === "waiting" ? <Spinner /> : <Icon name={MARK[note.kind]} size="sm" />}
          </span>
          <span className="nx-note-words">{note.words}</span>
          {note.kind === "update" ? (
            <Button size="sm" variant="quiet" onClick={onUpdate}>
              Update…
            </Button>
          ) : null}
          {note.kind === "host" && onHost ? (
            <Button size="sm" variant="quiet" onClick={() => onHost(note.server)}>
              Hosting…
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
  );
}

/** Each line's mark, where it isn't a spinner. */
const MARK = { keyring: "key", host: "house", update: "download" } as const;

/** One server can have several host lines, so those are told apart by what they're about. */
function keyOf(note: ListNote): string {
  if (note.kind === "host") return `${note.kind} ${note.server} ${note.what}`;
  return "server" in note ? `${note.kind} ${note.server}` : note.kind;
}
