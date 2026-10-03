import { memo, useEffect, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import { fileSize, inlineBox, renderAs } from "../../../lib/media";
import { Button, Icon, TextField } from "../../kit";
import { isVoiceMessage } from "../../core/chat/voiceMessage";
import { AudioCard } from "./AudioCard";
import "./Attachments.css";

/**
 * A message's files. Images and video are sized before their bytes arrive,
 * so a row is measured once at its real height and never grows under the
 * rows below it (the list is virtualized; lessons L-14). Audio gets Linger's
 * own player (`AudioCard`, #247); a video keeps the engine's. Anything that
 * isn't a picture, a video or a sound is never shown in the app: it is handed
 * to the system to save (ARCHITECTURE §7).
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
  onDownload: (file: Attachment) => Promise<void>;
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
  onDownload: (file: Attachment) => Promise<void>;
}) {
  const box = inlineBox(file.width, file.height);
  switch (renderAs(file.mime)) {
    case "image":
      return (
        <button type="button" className="nx-att-image" aria-label={`Open ${file.filename}`} onClick={() => onOpenImage(file)}>
          {/* The smaller copy, where the server made one (#382): the original opens in the viewer. */}
          <img src={mediaUrl(file.display_url ?? file.url)} alt={file.filename} width={box?.width} height={box?.height} loading="lazy" decoding="async" />
        </button>
      );
    case "video":
      return (
        <Video
          name={file.filename}
          src={mediaUrl(file.url)}
          poster={file.poster_url === null ? undefined : mediaUrl(file.poster_url)}
          box={box}
        />
      );
    case "audio":
      return (
        <AudioCard
          name={file.filename}
          src={mediaUrl(file.url)}
          durationMs={file.duration_ms === null ? null : Number(file.duration_ms)}
          voice={isVoiceMessage(file.filename, file.mime)}
        />
      );
    case "file":
      return <FileCard file={file} url={mediaUrl(file.url)} onDownload={onDownload} />;
  }
}

/**
 * A shared video, in a frame sized before its bytes arrive. If it stops
 * loading (the connection dropped, or a server too old to answer a seek,
 * #222), the frame says so and offers to load it again right here, from
 * where it had got to, rather than leaving a dead player that only leaving
 * the room would bring back.
 */
function Video({
  name,
  src,
  poster,
  box,
}: {
  name: string;
  src: string;
  poster: string | undefined;
  box: { width: number; height: number } | null;
}) {
  // Each go is a new element: one that has failed keeps its failure, and in
  // the Linux app it holds a GStreamer pipeline that has already given up.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const resumeAt = useRef(0);
  const player = useRef<HTMLVideoElement>(null);
  // The button that was just pressed goes away; the keyboard lands on the player.
  useEffect(() => {
    if (attempt > 0) player.current?.focus();
  }, [attempt]);
  return (
    <div className="nx-att-video">
      <video
        key={attempt}
        ref={player}
        className="nx-att-video-player"
        src={src}
        poster={poster}
        width={box?.width}
        height={box?.height}
        controls
        // Nothing until it's played (#381). Asking for even the metadata
        // makes the engine build the whole player, a hardware decoder
        // included: about 190 MB a video in WebKitGTK on NVIDIA, about 45 MB
        // in WebView2, for every video in the loaded history, watched or not.
        // The poster and the server's duration need none of it. "Load
        // again" was asked for, so a second go loads straight away.
        preload={attempt === 0 ? "none" : "metadata"}
        aria-label={name}
        onError={(event) => {
          resumeAt.current = event.currentTarget.currentTime;
          setFailed(true);
        }}
        onLoadedMetadata={(event) => {
          const at = resumeAt.current;
          resumeAt.current = 0;
          if (at > 0 && at < event.currentTarget.duration) event.currentTarget.currentTime = at;
        }}
      />
      {failed ? (
        <div className="nx-att-video-failed">
          <p className="nx-att-video-note" role="alert">
            Couldn't load this video.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setFailed(false);
              setAttempt((count) => count + 1);
            }}
          >
            Load again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A file that isn't a picture, a video or a sound: its name and size, and a
 * download that goes to the browser (FILE-6). It says so once handed over,
 * never claiming the file was saved, and a handoff that fails offers another
 * go; either way the address is there to copy. The bytes never pass through
 * this window.
 */
function FileCard({ file, url, onDownload }: { file: Attachment; url: string; onDownload: (file: Attachment) => Promise<void> }) {
  const [phase, setPhase] = useState<"idle" | "opening" | "handed" | "failed">("idle");
  const download = async () => {
    setPhase("opening");
    try {
      await onDownload(file);
      setPhase("handed");
    } catch {
      // What the desktop said may hold a signed address; the way out matters, not the error.
      setPhase("failed");
    }
  };
  return (
    <div className="nx-att-card" data-download={phase === "idle" ? undefined : phase}>
      <Icon name="file" size="md" />
      <span className="nx-att-name">{file.filename}</span>
      <span className="nx-att-meta">{fileSize(Number(file.size_bytes))}</span>
      <Button size="sm" variant="secondary" icon="download" busy={phase === "opening"} onClick={() => void download()}>
        {phase === "failed" ? "Try again" : "Download"}
      </Button>
      {phase === "handed" || phase === "failed" ? (
        <div className="nx-att-download">
          <p className="nx-att-download-note" role={phase === "failed" ? "alert" : "status"}>
            {phase === "failed"
              ? "Couldn't open your browser. Try again, or copy this address into it."
              : "Your browser has it: look in its downloads. If nothing opened, copy this address into it."}
          </p>
          <TextField label={`Address of ${file.filename}`} hideLabel value={url} onChange={() => undefined} readOnly mono literal size="sm" />
        </div>
      ) : null}
    </div>
  );
}
