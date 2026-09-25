import { useEffect, useRef, useState } from "react";
import { useAutoGrow } from "../../../lib/autoGrow";
import type { Message } from "../../../generated/Message";
import "./EditBox.css";

/** The server's cap on a message (`linger-core::limits::MAX_MESSAGE_CHARS`). */
export const MAX_MESSAGE_CHARS = 8000;

/**
 * Editing in place (parity CONV-23): Enter saves, Shift+Enter adds a line,
 * Escape gives up, the cursor starts at the end, and the words survive a
 * refusal, which is said on the spot.
 */
export function EditBox({ message, onSave, onDone }: { message: Message; onSave: (body: string) => Promise<void>; onDone: () => void }) {
  const [draft, setDraft] = useState(message.body);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  // Focus comes here, and goes back where it came from when the edit ends
  // (the message box, for Up), unless it has already moved on.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const opener = document.activeElement;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    return () => {
      const now = document.activeElement;
      const lost = now === null || now === document.body || now === element;
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useAutoGrow(box, draft);

  const save = async () => {
    const body = draft.trim();
    if (saving) return;
    if (body === message.body.trim()) {
      onDone();
      return;
    }
    if (body.length === 0) {
      setProblem("An empty message is a delete, and that is a different button.");
      return;
    }
    setSaving(true);
    try {
      await onSave(body);
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
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
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
    </div>
  );
}
