import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAutoGrow } from "../../../lib/autoGrow";
import { loadEmoji } from "../../../lib/emoji";
import { rememberEmoji } from "../../../lib/emoji/recent";
import { completeShortcode, convertShortcodes, putShortcode } from "../../../lib/emoji/shortcodes";
import type { Message } from "../../../generated/Message";
import { saysNothing } from "../../core/chat/sending";
import type { CustomEmojiByName } from "./MessageText";
import { useEmojiIndex } from "./useEmojiIndex";
import { shortcodeGlyph, useEmojiShortcodes } from "./useEmojiShortcodes";
import "./EditBox.css";

/** The server's cap on a message (`linger-core::limits::MAX_MESSAGE_CHARS`). */
export const MAX_MESSAGE_CHARS = 8000;

const NO_EMOJI: CustomEmojiByName = new Map();

/**
 * Editing in place (parity CONV-23): Enter saves, Shift+Enter adds a line,
 * Escape gives up, the cursor starts at the end, and the words survive a
 * refusal, which is said on the spot.
 *
 * Emoji by name work as they do in the message box (#359, #666): a `:` and
 * two characters offer them, a finished `:smiley:` becomes 😃 as it's typed,
 * and one still left as typed when the edit is saved (pasted, or finished
 * before the emoji list was in) goes as its emoji. A server's own emoji stays
 * its `:name:`.
 */
export function EditBox({
  message,
  emoji = NO_EMOJI,
  onSave,
  onDone,
}: {
  message: Message;
  /** The server's own emoji, offered after a `:`. */
  emoji?: CustomEmojiByName;
  onSave: (body: string) => Promise<void>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(message.body);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  // Where the caret goes once an emoji is in the box.
  const caretAfter = useRef<number | null>(null);

  // Focus comes here, and goes back where it came from when the edit ends
  // (the message box, for Up), unless it has already moved on.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const opener = document.activeElement;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    // Ready before the first `:`, so a quick :smiley: still becomes 😃.
    void loadEmoji();
    return () => {
      const now = document.activeElement;
      const lost = now === null || now === document.body || now === element;
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useAutoGrow(box, draft);

  const custom = useMemo(() => [...emoji.values()], [emoji]);
  const shortcodes = useEmojiShortcodes({
    box,
    anchor: box,
    conversation: message.id,
    custom,
    put: (typing, pick) => {
      const insert = "glyph" in pick ? pick.glyph : `:${pick.custom.name}:`;
      const next = putShortcode(draft, typing, insert, MAX_MESSAGE_CHARS);
      if (next === null) {
        setProblem(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`);
        return;
      }
      rememberEmoji("glyph" in pick ? { glyph: pick.glyph } : { name: pick.custom.name });
      caretAfter.current = next.caret;
      setDraft(next.text);
    },
  });
  useEmojiIndex(draft.includes(":"));
  const glyphOf = (name: string) => shortcodeGlyph(name, (own) => emoji.has(own));

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    box.current?.setSelectionRange(at, at);
  }, [draft]);

  const save = async () => {
    const typed = draft.trim();
    if (saving) return;
    if (typed === message.body.trim()) {
      onDone();
      return;
    }
    if (saysNothing(typed)) {
      setProblem("An empty message is a delete, and that is a different button.");
      return;
    }
    setSaving(true);
    try {
      if (typed.includes(":")) await loadEmoji().catch(() => null);
      await onSave(convertShortcodes(typed, 0, glyphOf).text);
      onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nx-edit">
      <textarea
        ref={box}
        className="nx-edit-box"
        rows={1}
        value={draft}
        maxLength={MAX_MESSAGE_CHARS}
        aria-label="Edit this message"
        role="combobox"
        aria-autocomplete="list"
        {...shortcodes.aria}
        onSelect={(event) => shortcodes.track(event.currentTarget)}
        onBlur={() => shortcodes.close()}
        onCompositionEnd={(event) => shortcodes.track(event.currentTarget)}
        onChange={(event) => {
          const node = event.target;
          const done = completeShortcode(node.value, node.selectionStart, glyphOf);
          if (done) caretAfter.current = done.caret;
          setDraft(done ? done.text : node.value);
          shortcodes.track(node);
        }}
        onKeyDown={(event) => {
          // The emoji list, while it's open, has the arrows, Enter, Tab and
          // Escape; they don't save, give up, or reach the conversation.
          if (shortcodes.onKey(event)) {
            event.stopPropagation();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <p className="nx-edit-hint">{problem ?? "Enter saves · Escape cancels"}</p>
      {shortcodes.list}
    </div>
  );
}
