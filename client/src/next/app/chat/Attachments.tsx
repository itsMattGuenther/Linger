import { memo } from "react";
import type { Attachment } from "../../../generated/Attachment";
import { durationText, fileSize, inlineBox, renderAs } from "../../../lib/media";
import { Button, Icon } from "../../kit";
import "./Attachments.css";

/**
 * A message's files. Images and video are sized before their bytes arrive,
 * so a row is measured once at its real height and never grows under the
 * rows below it (the list is virtualized; lessons L-14). Anything that isn't
 * a picture, a video or a sound is never shown in the app: it is handed to
 * the system to save (ARCHITECTURE §7).
 */
export const Attachments = memo(function Attachments({
  files,
  mediaUrl,
  onOpenImage,
  onDownload,
}: {
  files: readonly Attachment[];
  /** A path the server gave, as a full URL on its media origin. */
  mediaUrl: (path: string) => string;
  onOpenImage: (file: Attachment) => void;
  onDownload: (file: Attachment) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="nx-atts">
      {files.map((file) => (
        <One key={file.id} file={file} mediaUrl={mediaUrl} onOpenImage={onOpenImage} onDownload={onDownload} />
      ))}
    </div>
  );
});

function One({
  file,
  mediaUrl,
  onOpenImage,
  onDownload,
}: {
  file: Attachment;
  mediaUrl: (path: string) => string;
  onOpenImage: (file: Attachment) => void;
  onDownload: (file: Attachment) => void;
}) {
  const box = inlineBox(file.width, file.height);
  switch (renderAs(file.mime)) {
    case "image":
      return (
        <button type="button" className="nx-att-image" aria-label={`Open ${file.filename}`} onClick={() => onOpenImage(file)}>
          <img src={mediaUrl(file.url)} alt={file.filename} width={box?.width} height={box?.height} loading="lazy" decoding="async" />
        </button>
      );
    case "video":
      return (
        <video
          className="nx-att-video"
          src={mediaUrl(file.url)}
          poster={file.poster_url === null ? undefined : mediaUrl(file.poster_url)}
          width={box?.width}
          height={box?.height}
          controls
          preload="metadata"
          aria-label={file.filename}
        />
      );
    case "audio":
      return (
        <div className="nx-att-card">
          <Icon name="audio" size="md" />
          <span className="nx-att-name">{file.filename}</span>
          {file.duration_ms === null ? null : <span className="nx-att-meta">{durationText(Number(file.duration_ms))}</span>}
          <audio className="nx-att-audio" src={mediaUrl(file.url)} controls preload="metadata" aria-label={file.filename} />
        </div>
      );
    case "file":
      return (
        <div className="nx-att-card">
          <Icon name="file" size="md" />
          <span className="nx-att-name">{file.filename}</span>
          <span className="nx-att-meta">{fileSize(Number(file.size_bytes))}</span>
          <Button size="sm" variant="secondary" onClick={() => onDownload(file)}>
            Download
          </Button>
        </div>
      );
  }
}
