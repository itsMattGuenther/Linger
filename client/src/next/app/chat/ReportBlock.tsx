import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { onPhone } from "../../core/phone";
import { useBackButton } from "../useBackButton";
import { Button, Icon, type MenuAnchor, Popover, TextField } from "../../kit";
import "./ReportBlock.css";

/**
 * Report and block (SPEC §4.15, PROTOCOL §5, T-1605), in the least room that
 * does the job: each is a short form drawn in place of whatever opened it,
 * a person's card or a message's actions, never a window of its own.
 */

/** Ask the server; null when it took it, or what went wrong in words. */
export type Ask<T> = (value: T) => Promise<string | null>;

export interface ReportFormProps {
  /** Who it's about, by name. */
  who: string;
  /** A message being reported: its words as they are now. Left out for a person. */
  excerpt?: string;
  /** Who the report goes to: the host's name. */
  host: string;
  /** It goes to co-hosts as well as the host (#424), so it says so. */
  cohosts?: boolean;
  /** Send it with the note, or none. */
  onSend: Ask<string | null>;
  /** Back to what opened it, unsent or sent. */
  onDone: () => void;
}

/**
 * Report a message or a person to the host, with a note if you like. It says
 * where it goes before it goes: to the host, and the co-hosts if there are
 * any (#424), and nobody else, and the person isn't told. Once sent, it says
 * so in the same place.
 */
export function ReportForm({ who, excerpt, host, cohosts = false, onSend, onDone }: ReportFormProps) {
  // Who it goes to, said the same way in each place it's said.
  const to = cohosts ? `${host} and the co-hosts` : host;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  // Sent: the focus moves to Done, where the form's button was.
  useEffect(() => {
    if (sent) box.current?.querySelector("button")?.focus();
  }, [sent]);

  if (sent) {
    return (
      <div ref={box} className="nx-report" role="status">
        <p className="nx-report-sent">
          <Icon name="check" size="sm" />
          <span>{cohosts ? `Sent to ${to}. Only they see it.` : `Sent to ${host}. Only ${host} sees it.`}</span>
        </p>
        <div className="nx-report-buttons">
          <Button variant="secondary" size="md" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const said = await onSend(note.trim() === "" ? null : note.trim());
    setBusy(false);
    if (said === null) setSent(true);
    else setProblem(said);
  };

  return (
    <form className="nx-report" aria-label={excerpt === undefined ? `Report ${who}` : `Report ${who}'s message`} onSubmit={(event) => void submit(event)}>
      <h3 className="nx-report-title">{excerpt === undefined ? `Report ${who}` : `Report ${who}'s message`}</h3>
      <p className="nx-report-lead">
        {cohosts ? `It goes to ${to}, and to nobody else.` : `It goes to ${host}, who hosts this server, and to nobody else.`}{" "}
        {who} isn't told.
      </p>
      {excerpt === undefined ? null : <p className="nx-report-quote">{excerpt.trim() === "" ? "A file" : excerpt}</p>}
      <TextField label={cohosts ? "A note for them, if you like" : `A note for ${host}, if you like`} value={note} onChange={setNote} placeholder="What's going on?" autoFocus />
      {problem ? (
        <p className="nx-report-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="nx-report-buttons">
        <Button variant="secondary" size="md" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="md" type="submit" busy={busy}>
          {cohosts ? "Send the report" : `Send to ${host}`}
        </Button>
      </div>
    </form>
  );
}

export interface BlockFormProps {
  /** Who, by name. */
  who: string;
  onBlock: Ask<void>;
  onDone: () => void;
}

/**
 * Block somebody, said plainly before it's done: what changes for you, that
 * they aren't told, and how to undo it.
 */
export function BlockForm({ who, onBlock, onDone }: BlockFormProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  // Cancel first: blocking is the step a stray Enter shouldn't take.
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
  }, []);
  const block = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const said = await onBlock();
    setBusy(false);
    if (said === null) onDone();
    else setProblem(said);
  };
  return (
    <div ref={box} className="nx-report" role="group" aria-label={`Block ${who}`}>
      <h3 className="nx-report-title">Block {who}?</h3>
      <ul className="nx-report-list">
        <li>Their messages fold into a grey line you can open.</li>
        <li>Their DMs never light up or chime, and their knocks stop reaching you.</li>
        <li>{who} isn't told, and still sees what you say in rooms.</li>
        <li>Unblock any time, here or in Settings › Account.</li>
      </ul>
      {problem ? (
        <p className="nx-report-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="nx-report-buttons">
        <Button variant="secondary" size="md" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="danger" size="md" icon="block" busy={busy} onClick={() => void block()}>
          Block {who}
        </Button>
      </div>
    </div>
  );
}

/** Space kept between the form, what opened it and the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * A report form floating by what opened it (a message's ··· menu): under it
 * if it fits, over it if not, its right edge at the menu's, and never off the
 * window. Measured before it's painted. Drawn at the page's top level, as the
 * menu is: a message's row is moved into place on the list with a transform,
 * and a form fixed inside it would be placed from the row instead of the
 * window, off the side of the screen.
 */
export function FloatingForm({ anchor, label, onClose, children }: { anchor: MenuAnchor; label: string; onClose: () => void; children: ReactNode }) {
  // On the phone it rises from the bottom, as the message's sheet did, and
  // Back closes it (SPEC §4.15).
  if (onPhone()) {
    return (
      <SheetForm label={label} onClose={onClose}>
        {children}
      </SheetForm>
    );
  }
  return (
    <PlacedForm anchor={anchor} label={label} onClose={onClose}>
      {children}
    </PlacedForm>
  );
}

function SheetForm({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useBackButton(true, onClose);
  return createPortal(
    <>
      <div className="k-menu-scrim" aria-hidden="true" onClick={onClose} />
      <div className="nx-report-sheet" role="dialog" aria-label={label}>
        {children}
      </div>
    </>,
    document.body,
  );
}

function PlacedForm({ anchor, label, onClose, children }: { anchor: MenuAnchor; label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });
  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(anchor.right - width), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom, anchor.right]);
  return createPortal(
    <Popover label={label} at={at} onClose={onClose}>
      <div ref={box} className="nx-report-float">
        {children}
      </div>
    </Popover>,
    document.body,
  );
}
