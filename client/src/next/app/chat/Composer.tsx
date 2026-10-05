import { type FormEvent, type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { useAutoGrow } from "../../../lib/autoGrow";
import { insertGlyph } from "../../../lib/composerEmoji";
import { loadEmoji, withTone } from "../../../lib/emoji";
import { rememberEmoji, skinTone } from "../../../lib/emoji/recent";
import { completeShortcode, convertShortcodes, putShortcode } from "../../../lib/emoji/shortcodes";
import { type MentionPerson, type MentionTyping, putMention } from "../../core/chat/mentions";
import { afterFailure, canSend, type ComposerNow, dropUnsent, keepUnsent, type Submission } from "../../core/chat/sending";
import { planPaste } from "../../core/chat/paste";
import { excerpt } from "../../core/chat/words";
import { Button, Icon, IconButton, Name } from "../../kit";
import { MAX_MESSAGE_CHARS } from "./EditBox";
import { EmojiPicker, type PickedEmoji } from "./EmojiPicker";
import "./Composer.css";
import type { DraftFile } from "../../core/chat/drafts";
import { useFitsOneLine } from "./useFitsOneLine";
import { useEmojiIndex } from "./useEmojiIndex";
import { useEmojiShortcodes } from "./useEmojiShortcodes";
import { useMentions } from "./useMentions";
import type { VoiceMessageControls } from "./useVoiceMessages";
import { VoiceMessagePanel } from "./VoiceMessagePanel";

/** `linger-core::limits::MAX_ATTACHMENTS_PER_MESSAGE`, mirrored to refuse the eleventh file up front. */
export const MAX_ATTACHMENTS = 10;

/**
 * How long a paste's words wait on the desktop shell for a picture before
 * going in anyway (core/chat/paste.ts). It answers in a moment; this is for
 * a clipboard owner that doesn't.
 */
const WORDS_WAIT_MS = 1500;

/** A paste this soon after a middle-button press is that click's selection paste. */
const MIDDLE_PASTE_MS = 1000;

/** A file on its way into the next message. The window uploads it; the composer shows it. */
export type { DraftFile };

const NOBODY: readonly MentionPerson[] = [];
const NO_EMOJI: readonly CustomEmoji[] = [];

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
  /**
   * Who an `@` offers here, in order (core/chat/mentions.ts `mentionable`):
   * everyone on the server with the room's people first, or a DM's people.
   */
  mentionable?: readonly MentionPerson[];
  /**
   * Where the page's own paste event can't see a picture on the clipboard
   * (WebKitGTK, the Linux app): the desktop shell's reader, which the box
   * asks instead (#276, core/chat/paste.ts). Left out where the engine shows
   * the paste its files.
   */
  clipboardImage?: () => Promise<File | null>;
  /**
   * Voice messages (#401): the microphone button and the panel it opens,
   * for this conversation. Left out where there's no recorder.
   */
  voiceMessage?: VoiceMessageControls;
  /** The conversation's server's own emoji (#359), offered after a `:` and in the picker. */
  customEmoji?: readonly CustomEmoji[];
  /** The server's name, which the picker calls its own emoji by. */
  serverName?: string;
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
 * - An `@` at the start of a word offers people to mention (#267,
 *   `useMentions`); choosing one puts in their `@username`.
 * - A picture pasted from the clipboard goes on the draft like a file added
 *   with the + button, and wins over any words copied with it (#276,
 *   core/chat/paste.ts).
 * - A `:` and two characters offer emoji by name (#359, `useEmojiShortcodes`),
 *   and a finished `:smiley:` becomes 😃 as it's typed. A server's own emoji
 *   goes in as its `:name:`, which the conversation draws as the picture.
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
  mentionable = NOBODY,
  clipboardImage,
  voiceMessage,
  customEmoji = NO_EMOJI,
  serverName = "This server",
}: ComposerProps) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [unsent, setUnsent] = useState<Submission[]>([]);
  const [inFlight, setInFlight] = useState<ReadonlySet<number>>(new Set());
  const [emoji, setEmoji] = useState(false);
  const serial = useRef(0);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const boxRow = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  // Where the caret goes once a chosen mention is in the box.
  const caretAfter = useRef<number | null>(null);
  // When the middle button last went down in the box (a selection paste).
  const middleAt = useRef(Number.NEGATIVE_INFINITY);
  // Pastes waiting on the desktop shell, finished in the order they were made.
  const pasting = useRef<Promise<void>>(Promise.resolve());

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

  const mentions = useMentions({
    box,
    anchor: boxRow,
    conversation,
    people: mentionable,
    put: (typing: MentionTyping, user: User) => {
      const next = putMention(draft, typing, user.username, MAX_MESSAGE_CHARS);
      if (next === null) {
        say(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`);
        return;
      }
      caretAfter.current = next.caret;
      change(next.text);
      onTyping();
    },
  });
  const shortcodes = useEmojiShortcodes({
    box,
    anchor: boxRow,
    conversation,
    custom: customEmoji,
    put: (typing, pick) => {
      const insert = "glyph" in pick ? pick.glyph : `:${pick.custom.name}:`;
      const next = putShortcode(draft, typing, insert, MAX_MESSAGE_CHARS);
      if (next === null) {
        say(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`);
        return;
      }
      rememberEmoji("glyph" in pick ? { glyph: pick.glyph } : { name: pick.custom.name });
      caretAfter.current = next.caret;
      change(next.text);
      onTyping();
    },
  });
  // The emoji list, once there's a `:` that might be a shortcode or the
  // picker is open: a finished `:smiley:` needs it to become 😃.
  const emojiIndex = useEmojiIndex(emoji || draft.includes(":"));
  const glyphOf = (name: string): string | null => {
    // A server's own emoji by that name wins on its server: it stays `:name:`.
    if (customEmoji.some((one) => one.name === name)) return null;
    const found = emojiIndex?.byShortcode.get(name);
    return found ? withTone(found, skinTone()) : null;
  };

  // Shortcodes finished before the list had loaded become emoji once it has.
  const hadIndex = useRef(emojiIndex !== null);
  useEffect(() => {
    if (emojiIndex === null || hadIndex.current) return;
    hadIndex.current = true;
    const done = convertShortcodes(draft, box.current?.selectionStart ?? draft.length, glyphOf);
    if (done.text === draft) return;
    caretAfter.current = done.caret;
    change(done.text);
  }, [emojiIndex]);

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    box.current?.setSelectionRange(at, at);
  }, [draft]);

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
    // The : and @ lists, while one is open, have the arrows, Enter, Tab and Escape.
    if (shortcodes.onKey(event)) return;
    if (mentions.onKey(event)) return;
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
    const room = MAX_ATTACHMENTS - now.current.fileCount;
    say(chosen.length > room ? `One message carries at most ${MAX_ATTACHMENTS} files.` : null);
    const taking = chosen.slice(0, Math.max(0, room));
    if (taking.length > 0) onAttach(taking);
  };

  // A paste's words, put in where the engine would have put them: at the
  // caret, over any selection, cut to the box's length, and one step for
  // Undo of its own, not merged into the typing before or after.
  const putWords = (words: string) => {
    const field = box.current;
    if (!field) return;
    field.focus();
    const text = words.replace(/\r\n?/g, "\n");
    const seal = () => field.setSelectionRange(field.selectionStart, field.selectionEnd, field.selectionDirection);
    seal();
    const put = document.execCommand("insertText", false, text);
    seal();
    if (put) return;
    // An engine without the editing command: the box's own state, with no Undo.
    const next = insertGlyph(now.current.draft, text, field.selectionStart, field.selectionEnd, MAX_MESSAGE_CHARS);
    if (next === null) {
      say(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`);
      return;
    }
    caretAfter.current = next.caret;
    change(next.text);
    onTyping();
  };

  // A paste the engine can't finish: ask the desktop shell for the picture
  // on the clipboard, then attach it, or put the paste's words in. Pastes
  // finish in order, and only in the conversation they were made in.
  const pasteThroughShell = (read: () => Promise<File | null>, words: string) => {
    const where = conversation;
    const asked = read().catch(() => null);
    const answer = words === "" ? asked : Promise.race([asked, new Promise<null>((settle) => window.setTimeout(() => settle(null), WORDS_WAIT_MS))]);
    pasting.current = pasting.current
      .then(() => answer)
      .then((image) => {
        if (now.current.conversation !== where) return;
        if (image) attach([image]);
        else if (words !== "") putWords(words);
      })
      // One paste going wrong never holds up the next.
      .catch(() => undefined);
  };

  const putEmoji = (picked: PickedEmoji) => {
    const field = box.current;
    const from = field?.selectionStart ?? draft.length;
    // A server's own emoji goes in as `:name:`, a word of its own.
    const glyph =
      "glyph" in picked ? picked.glyph : `${from > 0 && !/\s/.test(draft[from - 1] ?? "") ? " " : ""}:${picked.custom.name}: `;
    const next = insertGlyph(draft, glyph, from, field?.selectionEnd ?? draft.length, MAX_MESSAGE_CHARS);
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
  // Who it's to, when that fits on the box's one line; just "Say something"
  // when it doesn't, as on a phone, where the screen's title says it anyway.
  const named = replyTo ? "Say something back" : isDm ? `Say something to ${title}` : `Say something in ${title}`;
  const placeholder = useFitsOneLine(box, named) ? named : replyTo ? "Say something back" : "Say something";

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
        <ul className="nx-composer-files" aria-label="Files for this message" data-pictures={files.some((file) => file.preview) ? "yes" : undefined}>
          {files.map((file) => (
            <li key={file.key} className="nx-composer-file" data-problem={file.problem ? "yes" : undefined}>
              <span className="nx-composer-file-lead">
                {file.preview ? <img className="nx-composer-file-thumb" src={file.preview} alt="" draggable={false} /> : <Icon name="file" size="sm" />}
              </span>
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

      {voiceMessage ? <VoiceMessagePanel controls={voiceMessage} title={title} /> : null}

      <div className="nx-composer-box" ref={boxRow}>
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
          {...mentions.field}
          {...(shortcodes.open ? shortcodes.aria : {})}
          onSelect={(event) => {
            mentions.field.onSelect(event);
            shortcodes.track(event.currentTarget);
          }}
          onFocus={(event) => {
            mentions.field.onFocus(event);
            shortcodes.track(event.currentTarget);
            // Ready before the first `:`, so a quick :smiley: still becomes 😃.
            void loadEmoji();
          }}
          onBlur={() => {
            mentions.field.onBlur();
            shortcodes.close();
          }}
          onCompositionEnd={(event) => {
            mentions.field.onCompositionEnd(event);
            shortcodes.track(event.currentTarget);
          }}
          onChange={(event) => {
            const node = event.target;
            const done = completeShortcode(node.value, node.selectionStart, glyphOf);
            if (done) caretAfter.current = done.caret;
            change(done ? done.text : node.value);
            mentions.track(node);
            shortcodes.track(node);
            if (node.value !== "") onTyping();
          }}
          onKeyDown={onKeyDown}
          onMouseDown={(event) => {
            if (event.button === 1) middleAt.current = performance.now();
          }}
          onPaste={(event) => {
            const selection = performance.now() - middleAt.current < MIDDLE_PASTE_MS;
            middleAt.current = Number.NEGATIVE_INFINITY;
            const plan = planPaste(event.clipboardData, { shell: clipboardImage !== undefined, selection, at: new Date() });
            if (plan.kind === "engine") return;
            event.preventDefault();
            if (plan.kind === "files") attach(plan.files);
            else if (clipboardImage) pasteThroughShell(clipboardImage, plan.words);
          }}
        />
        {voiceMessage ? <IconButton icon="mic" label="Record a voice message" expanded={voiceMessage.state !== null} onClick={voiceMessage.open} /> : null}
        <IconButton icon="plus" label="Add a file" onClick={() => picker.current?.click()} />
        <span className="nx-composer-emoji-anchor" ref={emojiAnchor}>
          <IconButton icon="smile" label="Emoji" expanded={emoji} onClick={() => setEmoji((open) => !open)} />
          {emoji ? (
            <EmojiPicker
              custom={customEmoji}
              serverName={serverName}
              onPick={putEmoji}
              onClose={() => {
                setEmoji(false);
                box.current?.focus();
              }}
            />
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

      {mentions.list}
      {shortcodes.list}

      {/* Only near the ceiling: a counter that is always on is a scold. */}
      {left <= 200 ? <p className="nx-composer-left">{left} characters left</p> : null}
    </form>
  );
});
