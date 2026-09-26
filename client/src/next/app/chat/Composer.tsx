import { type FormEvent, type KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { useAutoGrow } from "../../../lib/autoGrow";
import { COMPOSER_EMOJI, insertGlyph } from "../../../lib/composerEmoji";
import { afterFailure, canSend, type ComposerNow, dropUnsent, keepUnsent, type Submission } from "../../core/chat/sending";
import { excerpt } from "../../core/chat/words";
import { Button, Icon, IconButton, Name } from "../../kit";
import { MAX_MESSAGE_CHARS } from "./EditBox";
import "./Composer.css";
import type { DraftFile } from "../../core/chat/drafts";

/** `linger-core::limits::MAX_ATTACHMENTS_PER_MESSAGE`, mirrored to refuse the eleventh file up front. */
export const MAX_ATTACHMENTS = 10;

/** A file on its way into the next message. The window uploads it; the composer shows it. */
export type { DraftFile };

export interface ComposerProps {
  /**
   * The conversation showing (its tab id). The box keeps a draft, a problem
   * and any unsent messages per conversation while the window is open
   * (decision 11), so switching tabs never carries a half-typed line along.
   */
  conversation: string;
  /** "#general", or the people in a DM. */
  title: string;
  isDm: boolean;
  replyTo: { message: Message; author: User | undefined } | null;
  onClearReply: () => void;
  /** A failed send went back in the box: reply to this again. */
  onRestoreReply: (id: MessageId) => void;
  /** Files waiting for the next message in this conversation. */
  files: readonly DraftFile[];
  onAttach: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
  /** A failed send went back in the box: these files are the draft's again. */
  onRestoreFiles: (keys: string[]) => void;
  /**
   * Send, in `submission.conversation`. The window takes the named files out
   * of the draft for the attempt and holds them until it resolves: on
   * success they're gone, on failure they wait with the unsent message (or
   * come back with `onRestoreFiles`). Rejects with a sentence.
   */
  onSend: (submission: Submission) => Promise<void>;
  /** Someone typed (the store rate-limits what it sends). */
  onTyping: () => void;
  /** Up in an empty box: edit your last message. */
  onEditLast: () => void;
  /** Changes when the window wants the cursor in the box: it opened, or a conversation was opened from the list. */
  focusRequest?: number;
  /**
   * A draft that came with a conversation from another window. Put in that
   * conversation's box if it's empty; a new object each time one arrives.
   */
  seed?: { conversation: string; text: string } | null;
  /** The box's text changed, for a window that has to carry it elsewhere. Called often: keep it cheap. */
  onDraft?: (conversation: string, text: string) => void;
  /**
   * Where half-typed lines are kept between tabs and restarts (decision 11,
   * core/chat/keptDrafts.ts). Left out, a draft lasts as long as the box.
   */
  keep?: { load: (conversation: string) => string; save: (conversation: string, text: string) => void };
}

/**
 * The message box (SPEC §4.7 "Sending", lessons L-12 and L-16).
 *
 * - Enter sends at once and keeps focus; what you type next is the next
 *   message. Shift+Enter adds a line. Several sends can be in flight.
 * - A send that fails goes back in the box only if the box is untouched;
 *   otherwise it waits apart with a retry. A newer draft is never touched.
 * - It grows with its text by measuring a hidden copy, never the page, so
 *   typing never lays out the conversation (L-12). Its state is its own, so
 *   a keystroke redraws only the box.
 */
export const Composer = memo(function Composer({
  conversation,
  title,
  isDm,
  replyTo,
  onClearReply,
  onRestoreReply,
  files,
  onAttach,
  onRemoveFile,
  onRestoreFiles,
  onSend,
  onTyping,
  onEditLast,
  focusRequest,
  seed,
  onDraft,
  keep,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [unsent, setUnsent] = useState<Submission[]>([]);
  const [inFlight, setInFlight] = useState<ReadonlySet<number>>(new Set());
  const [emoji, setEmoji] = useState(false);
  const serial = useRef(0);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const draft = drafts.get(conversation) ?? keep?.load(conversation) ?? "";
  const problem = problems.get(conversation) ?? null;

  // What the box holds right now, for deciding what a late failure may touch.
  const now = useRef<ComposerNow>({ conversation, draft, fileCount: files.length, replying: replyTo !== null });
  now.current = { conversation, draft, fileCount: files.length, replying: replyTo !== null };

  useAutoGrow(box, draft);

  useEffect(() => {
    if (focusRequest !== undefined) box.current?.focus();
  }, [focusRequest]);

  // Choosing to reply is choosing to type; showing another tab that has a
  // reply waiting is not.
  const replyId = replyTo?.message.id ?? null;
  const lastReply = useRef({ conversation, id: replyId });
  useEffect(() => {
    const before = lastReply.current;
    lastReply.current = { conversation, id: replyId };
    if (replyId !== null && before.conversation === conversation && before.id !== replyId) box.current?.focus();
  }, [conversation, replyId]);

  // The emoji panel belongs to the box it was opened over, and closes on a
  // click anywhere else.
  const emojiAnchor = useRef<HTMLSpanElement | null>(null);
  useEffect(() => setEmoji(false), [conversation]);
  useEffect(() => {
    if (!emoji) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && emojiAnchor.current?.contains(event.target)) return;
      setEmoji(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [emoji]);

  const change = (next: string, where = conversation) => {
    setDrafts((held) => new Map(held).set(where, next));
    if (where === now.current.conversation) now.current = { ...now.current, draft: next };
    onDraft?.(where, next);
    keep?.save(where, next);
  };

  // A draft that travelled here from another window, into an empty box only.
  useEffect(() => {
    if (!seed) return;
    setDrafts((held) => {
      if ((held.get(seed.conversation) ?? keep?.load(seed.conversation) ?? "") !== "") return held;
      onDraft?.(seed.conversation, seed.text);
      keep?.save(seed.conversation, seed.text);
      return new Map(held).set(seed.conversation, seed.text);
    });
  }, [seed]);

  const say = (text: string | null, where = conversation) =>
    setProblems((held) => {
      const next = new Map(held);
      if (text === null) next.delete(where);
      else next.set(where, text);
      return next;
    });

  const ready = files.filter((file) => file.ready);
  const uploading = files.some((file) => !file.ready && file.problem === null);

  const deliver = async (submission: Submission): Promise<void> => {
    setInFlight((held) => new Set(held).add(submission.key));
    say(null, submission.conversation);
    try {
      await onSend(submission);
      setUnsent((held) => dropUnsent(held, submission.key));
    } catch (error) {
      say(error instanceof Error ? error.message : "Couldn't send the message.", submission.conversation);
      if (afterFailure(submission, now.current) === "restore") {
        change(submission.body, submission.conversation);
        if (submission.replyTo !== null) onRestoreReply(submission.replyTo);
        if (submission.fileKeys.length > 0) onRestoreFiles(submission.fileKeys);
        setUnsent((held) => dropUnsent(held, submission.key));
      } else {
        setUnsent((held) => keepUnsent(held, submission));
      }
    } finally {
      setInFlight((held) => {
        const next = new Set(held);
        next.delete(submission.key);
        return next;
      });
    }
  };

  const submit = () => {
    const verdict = canSend(draft, ready.length, uploading);
    if (!verdict.ok) {
      if (verdict.blocked) say(verdict.blocked);
      return;
    }
    serial.current += 1;
    const submission: Submission = {
      key: serial.current,
      conversation,
      body: draft.trim(),
      replyTo: replyTo?.message.id ?? null,
      fileKeys: ready.map((file) => file.key),
    };
    // Committed on Enter: from here on, keystrokes belong to the next message.
    change("");
    onClearReply();
    box.current?.focus();
    void deliver(submission);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && emoji) {
      event.preventDefault();
      setEmoji(false);
      return;
    }
    if (event.key === "Escape" && replyTo) {
      event.preventDefault();
      onClearReply();
      return;
    }
    if (event.key === "ArrowUp" && draft === "") {
      event.preventDefault();
      onEditLast();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const attach = (chosen: File[]) => {
    const room = MAX_ATTACHMENTS - files.length;
    say(chosen.length > room ? `One message carries at most ${MAX_ATTACHMENTS} files.` : null);
    const taking = chosen.slice(0, Math.max(0, room));
    if (taking.length > 0) onAttach(taking);
  };

  const putEmoji = (glyph: string) => {
    const field = box.current;
    const next = insertGlyph(draft, glyph, field?.selectionStart ?? draft.length, field?.selectionEnd ?? draft.length, MAX_MESSAGE_CHARS);
    if (next === null) {
      say(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`);
      return;
    }
    change(next.text);
    setEmoji(false);
    requestAnimationFrame(() => {
      const node = box.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  };

  const left = MAX_MESSAGE_CHARS - draft.length;
  const placeholder = replyTo ? "Say something back" : isDm ? `Say something to ${title}` : `Say something in ${title}`;

  return (
    <form
      className="nx-composer"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      // A dropped file is shared, never followed: a webview that navigates to
      // somebody's photo has replaced the app with it.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        attach([...event.dataTransfer.files]);
      }}
    >
      {replyTo ? (
        <div className="nx-composer-reply">
          <span className="nx-composer-reply-text">
            <span aria-hidden="true">↩ </span>
            Replying to {replyTo.author ? <Name person={replyTo.author} size="inline" /> : "someone"}:{" "}
            <span className="nx-composer-reply-words">{excerpt(replyTo.message.body, 90)}</span>
          </span>
          <IconButton icon="close" label="Don't reply" size="sm" onClick={onClearReply} />
        </div>
      ) : null}

      {unsent
        .filter((submission) => submission.conversation === conversation)
        .map((submission) => (
        <div className="nx-composer-unsent" key={submission.key} role="group" aria-label="Unsent message">
          <span className="nx-composer-unsent-text">
            <span className="nx-composer-unsent-label">Unsent</span> {submission.body || "a file"}
          </span>
          <Button size="sm" variant="secondary" busy={inFlight.has(submission.key)} disabled={inFlight.has(submission.key)} onClick={() => void deliver(submission)}>
            Retry
          </Button>
        </div>
      ))}

      {problem ? (
        <p className="nx-composer-problem" role="alert">
          {problem}
        </p>
      ) : null}

      {files.length === 0 ? null : (
        <ul className="nx-composer-files" aria-label="Files for this message">
          {files.map((file) => (
            <li key={file.key} className="nx-composer-file" data-problem={file.problem ? "yes" : undefined}>
              <Icon name="file" size="sm" />
              <span className="nx-composer-file-name">{file.name}</span>
              {file.problem ? (
                <span className="nx-composer-file-problem">{file.problem}</span>
              ) : file.ready ? null : (
                <span className="nx-composer-file-bar" role="progressbar" aria-label={`Uploading ${file.name}`} aria-valuenow={Math.round(file.progress * 100)}>
                  <span style={{ width: `${Math.round(file.progress * 100)}%` }} />
                </span>
              )}
              <IconButton icon="close" label={`Don't send ${file.name}`} size="sm" onClick={() => onRemoveFile(file.key)} />
            </li>
          ))}
        </ul>
      )}

      <div className="nx-composer-box">
        <span className="nx-composer-prompt" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={box}
          className="nx-composer-input"
          rows={1}
          value={draft}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder={placeholder}
          aria-label={isDm ? `Message ${title}` : `Message in ${title}`}
          autoComplete="off"
          onChange={(event) => {
            change(event.target.value);
            if (event.target.value !== "") onTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files];
            if (pasted.length > 0) {
              event.preventDefault();
              attach(pasted);
            }
          }}
        />
        <IconButton icon="plus" label="Add a file" onClick={() => picker.current?.click()} />
        <span className="nx-composer-emoji-anchor" ref={emojiAnchor}>
          <IconButton icon="smile" label="Emoji" expanded={emoji} onClick={() => setEmoji((open) => !open)} />
          {emoji ? (
            <div
              className="nx-composer-emoji"
              role="dialog"
              aria-label="Emoji"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setEmoji(false);
                box.current?.focus();
              }}
            >
              {COMPOSER_EMOJI.map((one) => (
                <button key={`${one.label}:${one.glyph}`} type="button" className="nx-composer-emoji-mark" aria-label={one.label} onClick={() => putEmoji(one.glyph)}>
                  {one.glyph}
                </button>
              ))}
            </div>
          ) : null}
        </span>
        <IconButton icon="send" label="Send" tone="accent" disabled={draft.trim().length === 0 && ready.length === 0} onClick={submit} />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            attach([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>

      {/* Only near the ceiling: a counter that is always on is a scold. */}
      {left <= 200 ? <p className="nx-composer-left">{left} characters left</p> : null}
    </form>
  );
});
