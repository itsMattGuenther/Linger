/**
 * Files, inside a message (SPEC §5.6, PROTOCOL §6).
 *
 * "Images render inline at true aspect ratio, capped at 400px height, click to
 * expand." Video gets its poster frame and a player; audio gets a player;
 * everything else gets one line and a way to save it. No cards, no thumbnails
 * in boxes, no drop shadows — a picture in a conversation is a picture.
 *
 * Two rules from the architecture show up here as code. Absolute URLs retain
 * their media origin (ARCHITECTURE §7); local paths resolve against the server
 * that supplied the message (PROTOCOL §6), never the WebView. And a
 * file that is not an image, a video or a sound is never rendered — it is
 * handed to the system browser to save, which is where a download belongs.
 */
import { useEffect, useState } from "react";

import type { Attachment } from "../generated/Attachment";
import { openExternal } from "../lib/external";
import { absoluteUrl } from "../lib/url";
import { durationText, fileSize, inlineBox, renderAs } from "./media";
import "./media.css";

export default function Attachments({ files, baseUrl }: { files: Attachment[]; baseUrl: string }) {
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="atts">
      {files.map((file) => (
        <One key={file.id} file={file} baseUrl={baseUrl} onExpand={() => setExpanded(file)} />
      ))}
      {expanded ? <Expanded file={expanded} baseUrl={baseUrl} onClose={() => setExpanded(null)} /> : null}
    </div>
  );
}

function One({ file, baseUrl, onExpand }: { file: Attachment; baseUrl: string; onExpand: () => void }) {
  const url = absoluteUrl(baseUrl, file.url);
  switch (renderAs(file.mime)) {
    case "image": {
      // The box is set before the bytes arrive so the row is measured at its
      // real height once, rather than growing under everything below it when
      // the picture loads — the list is virtualized and that shifts the world.
      const box = inlineBox(file.width, file.height);
      return (
        <button type="button" className="att-image" onClick={onExpand} title="expand">
          <img
            src={url}
            alt={file.filename}
            width={box?.width}
            height={box?.height}
            loading="lazy"
            decoding="async"
          />
        </button>
      );
    }
    case "video":
      return (
        <video
          className="att-video"
          src={url}
          poster={file.poster_url === null ? undefined : absoluteUrl(baseUrl, file.poster_url)}
          controls
          preload="metadata"
          aria-label={file.filename}
        />
      );
    case "audio":
      return (
        <div className="att-audio">
          <p className="att-line meta">
            <span className="att-name">{file.filename}</span>
            {file.duration_ms === null ? null : (
              <span className="att-size">{durationText(Number(file.duration_ms))}</span>
            )}
          </p>
          <audio src={url} controls preload="metadata" aria-label={file.filename} />
        </div>
      );
    default:
      return (
        <p className="att-line meta">
          <span className="att-name">{file.filename}</span>
          <span className="att-size">{fileSize(Number(file.size_bytes))}</span>
          {/* Handed to the system browser, never followed in this window: the
              server sends it as an attachment with `nosniff`, and a webview
              that navigates itself to somebody's upload has replaced the app
              with it (ARCHITECTURE §7, `lib/external.ts`). */}
          <button type="button" className="att-get" onClick={() => openExternal(url)}>
            save
          </button>
        </p>
      );
  }
}

/**
 * The expanded picture. Escape closes it, so does clicking anywhere — there is
 * nothing else on this layer and nothing to aim at.
 */
function Expanded({ file, baseUrl, onClose }: { file: Attachment; baseUrl: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="att-expanded"
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      onClick={onClose}
    >
      <img src={absoluteUrl(baseUrl, file.url)} alt={file.filename} />
      <p className="att-expanded-name meta">{file.filename}</p>
    </div>
  );
}
