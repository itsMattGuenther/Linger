/**
 * Writing your own status, and going away (SPEC §4.6).
 *
 * The AIM away message is the thing this app is nostalgic for, so the editor is
 * a small form and not a settings screen: a line, three labeled fields, and the
 * away message. Type an away message and you are away; clear it and you are
 * back. That is the same model AIM had, and it is why the away message lives on
 * the status rather than somewhere of its own.
 *
 * Two things happen on save, in this order:
 *
 * 1. `PATCH /me` writes the status. The server stamps `away_since` here and
 *    nowhere else, so the roster's "away 20m" counts off its clock, not ours.
 * 2. `setAway` puts it on the wire, which leaves the room first and then says
 *    `away` — the server sets `around` on any room leave, so the other order
 *    would wipe what we just set.
 *
 * The image (T-506) goes up the moment it is picked, because an upload is a
 * separate thing from a save: the status names a file that already exists. That
 * leaves one loose end, and it is handled here — a file uploaded and then
 * replaced, removed, or abandoned by closing the form was never named by
 * anything, so it is taken back off the server rather than left against the
 * pool. An image that *was* saved and is then replaced is the server's to clean
 * up, and it does.
 */
import { type FormEvent, useRef, useState } from "react";

import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "../lib/api";
import { saveStatus } from "../lib/gateway";
import { uploadFile } from "../lib/upload";
import { absoluteUrl } from "../lib/url";
import { setAway } from "../lib/watchPresence";
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
} from "./status";
import "./status.css";

/** The fields that are boxes of text. The image is not one of them. */
type TextKey = "line" | "reading" | "listening" | "workingOn" | "awayMessage";

/** Only worth saying when you are near it, the same way the composer does. */
function remaining(value: string, max: number, warnAt: number): string | null {
  const left = max - [...value].length;
  return left <= warnAt ? `${left} left` : null;
}

export default function StatusEditor({
  api,
  me,
  onDone,
}: {
  api: AuthedApi;
  me: User;
  onDone: () => void;
}) {
  const saved = me.status ?? null;
  const [draft, setDraft] = useState<StatusDraft>(() => draftOf(saved));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  /** Ids uploaded in this sitting and not saved to anything yet. */
  const unsaved = useRef<Set<string>>(new Set());

  const set = (key: TextKey, value: string): void => {
    setDraft((held) => ({ ...held, [key]: value }));
    setError(null);
  };

  /**
   * Point the draft at a different image, taking back the one it was holding if
   * that one only ever existed for this form.
   */
  const setImage = (next: StatusImage | null): void => {
    setDraft((held) => {
      const going = held.image?.id;
      if (going !== undefined && unsaved.current.delete(going)) {
        void api.cancelUpload(going).catch(() => undefined);
      }
      return { ...held, image: next };
    });
  };

  const attach = (file: File | undefined): void => {
    if (file === undefined) return;
    const refusal = imageProblem(file);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setError(null);
    setUploading(true);
    uploadFile(api, file)
      .then((attachment) => {
        const id = String(attachment.id);
        unsaved.current.add(id);
        setImage({ id, url: attachment.url });
      })
      .catch((problem: unknown) =>
        setError(
          problem instanceof ApiError ? problem.message : "That image didn't go up.",
        ),
      )
      .finally(() => setUploading(false));
  };

  /** Leaving without saving leaves nothing behind either. */
  const abandon = (): void => {
    setImage(null);
    onDone();
  };

  const tooLong = overLimit(draft);
  const dirty = isDirty(draft, saved);
  const away = (saved?.away_message ?? "") !== "";

  const commit = async (next: StatusDraft): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const status = statusOf(next, saved);
      await saveStatus(api, status);
      // Saved: the image is named by a status now, and taking it back would be
      // deleting somebody's picture. The one it replaced is the server's job.
      unsaved.current.clear();
      setAway(api.baseUrl, status.away_message);
      onDone();
    } catch (problem) {
      // The server's own words when it has any: PROTOCOL §1 promises the
      // message is written to be shown to a person.
      setError(
        problem instanceof ApiError
          ? problem.message
          : "Couldn't save that. The server didn't answer.",
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="status-editor"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!busy && tooLong === null) void commit(draft);
      }}
    >
      {/* Being away is the loudest thing on this form when it is true, because
          it is the thing people forget they left on. */}
      {away ? (
        <div className="editor-away-now">
          <p className="meta">you are away</p>
          <button
            type="button"
            className="editor-back"
            disabled={busy}
            onClick={() => void commit({ ...draft, awayMessage: "" })}
          >
            I’m back
          </button>
        </div>
      ) : null}

      <Line
        label="status"
        hint="One line, in your own styling."
        value={draft.line}
        max={MAX_LINE_CHARS}
        warnAt={40}
        rows={2}
        disabled={busy}
        onChange={(value) => set("line", value)}
      />

      {FIELDS.map((field) => (
        <label className="editor-field" key={field.key}>
          <span className="panel-label">{field.label}</span>
          <input
            type="text"
            className="editor-input"
            value={draft[field.key]}
            maxLength={MAX_FIELD_CHARS}
            disabled={busy}
            onChange={(event) => set(field.key, event.target.value)}
          />
          <Count text={remaining(draft[field.key], MAX_FIELD_CHARS, 20)} />
        </label>
      ))}

      <Line
        label="away message"
        // Saying what it does, because the effect is bigger than the field
        // looks: this is the switch that takes you out of the room.
        hint="Setting one makes you away, and it shows instead of your status."
        value={draft.awayMessage}
        max={MAX_LINE_CHARS}
        warnAt={40}
        rows={2}
        disabled={busy}
        onChange={(value) => set("awayMessage", value)}
      />

      {/* SPEC §4.6's one image. The picker is hidden and driven by the button,
          the way the composer's `+ file` is, so the control is a control and
          not a browser widget in the middle of a Console form. */}
      <div className="editor-field">
        <span className="panel-label">image</span>
        {draft.image === null ? null : (
          <img className="editor-image" src={absoluteUrl(api.baseUrl, draft.image.url)} alt="the image on your status" />
        )}
        <div className="editor-image-row">
          <button
            type="button"
            className="editor-pick"
            disabled={busy || uploading}
            onClick={() => picker.current?.click()}
          >
            {draft.image === null ? "+ image" : "replace"}
          </button>
          {draft.image === null ? null : (
            <button
              type="button"
              className="editor-cancel meta"
              disabled={busy || uploading}
              onClick={() => setImage(null)}
            >
              remove
            </button>
          )}
          {uploading ? <span className="editor-count meta">uploading…</span> : null}
        </div>
        <span className="editor-hint meta">
          One image, up to {MAX_IMAGE_BYTES / 1024} KB, shown at 400×200.
        </span>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            attach(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      {tooLong === null ? null : <p className="editor-problem">{tooLong}</p>}
      {error === null ? null : <p className="editor-problem">{error}</p>}

      <div className="editor-actions">
        <button type="button" className="editor-cancel meta" disabled={busy} onClick={abandon}>
          cancel
        </button>
        <button
          type="submit"
          className="editor-save"
          disabled={busy || uploading || !dirty || tooLong !== null}
        >
          {busy ? "saving…" : "save"}
        </button>
      </div>
    </form>
  );
}

/** A multi-line field with a label, a hint, and a countdown near the end. */
function Line({
  label,
  hint,
  value,
  max,
  warnAt,
  rows,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  warnAt: number;
  rows: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="editor-field">
      <span className="panel-label">{label}</span>
      <textarea
        className="editor-input"
        rows={rows}
        value={value}
        maxLength={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="editor-hint meta">{hint}</span>
      <Count text={remaining(value, max, warnAt)} />
    </label>
  );
}

function Count({ text }: { text: string | null }) {
  if (text === null) return null;
  return <span className="editor-count meta">{text}</span>;
}
