import { Button, Icon, Spinner } from "../../kit";
import type { ListNote } from "../../core/notes";
import "./ListNotes.css";

/**
 * The foot's standing lines (decision 1, `core/notes.ts`): a server that
 * can't be reached (with Try now, for one not reached since launch), a
 * computer that can't keep sign-ins, a new version. Only
 * while there is something to say; otherwise nothing is drawn at all.
 */
export function ListNotes({ notes, onUpdate, onRetry }: { notes: readonly ListNote[]; onUpdate: () => void; onRetry?: (server: string) => void }) {
  if (notes.length === 0) return null;
  return (
    <div className="nx-notes" aria-live="polite" data-screen="list-notes">
      {notes.map((note) => (
        <p key={"server" in note ? `${note.kind} ${note.server}` : note.kind} className="nx-note" data-note={note.kind} title={"detail" in note && note.detail ? note.detail : undefined}>
          <span className="nx-note-mark">
            {note.kind === "connection" || note.kind === "waiting" ? <Spinner /> : <Icon name={note.kind === "update" ? "download" : "key"} size="sm" />}
          </span>
          <span className="nx-note-words">{note.words}</span>
          {note.kind === "update" ? (
            <Button size="sm" variant="quiet" onClick={onUpdate}>
              Update…
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
