import { useEffect, useRef } from "react";
import { onPreviewPicture, setPreviewShown, usePreviewShown } from "../../../lib/screen/share";
import { Button, IconButton } from "../../kit";
import "./SharingBox.css";

/** Where your share's preview comes from: the page's own picture of it, or the shell's (Linux). */
export type SharePreview = { kind: "stream"; stream: MediaStream } | { kind: "pictures" };

/**
 * Your share, in the voice bar (SPEC §4.20, #360): a copy of what everybody
 * sees, so you know it's the slide and not your email; who is watching, by
 * name; and Stop. The eye hides the copy and shows it again, kept for next
 * time: hidden, it's no work for the computer. With the share in another of
 * your windows there's no copy here, only the words.
 */
export function SharingBox({ preview, watching, starting, onStop }: { preview: SharePreview | null; watching: string; starting: boolean; onStop: () => void }) {
  const shown = usePreviewShown();
  return (
    <div className="nx-sharing" role="group" aria-label="Your screen">
      {preview && shown ? (
        <div className="nx-sharing-preview">{preview.kind === "stream" ? <StreamPreview stream={preview.stream} /> : <PicturePreview />}</div>
      ) : null}
      <div className="nx-sharing-top">
        <span className="nx-sharing-words">{starting ? "Starting to share…" : "Sharing your screen"}</span>
        {preview ? <IconButton icon="preview" label="Show the preview" size="sm" pressed={shown} onClick={() => setPreviewShown(!shown)} /> : null}
        <Button size="sm" variant="secondary" onClick={onStop}>
          Stop
        </Button>
      </div>
      <p className="nx-sharing-who" role="status">
        {watching}
      </p>
    </div>
  );
}

/** The page's own share, played as it's taken. */
function StreamPreview({ stream }: { stream: MediaStream }) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={video} className="nx-sharing-picture" muted playsInline aria-hidden="true" />;
}

/** The shell's share: its small pictures, a few a second, each one shown as it comes. */
function PicturePreview() {
  const image = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    let shownUrl: string | null = null;
    const stop = onPreviewPicture((picture) => {
      const element = image.current;
      if (!element) return;
      const url = URL.createObjectURL(new Blob([picture], { type: "image/jpeg" }));
      element.src = url;
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      shownUrl = url;
    });
    return () => {
      stop();
      if (shownUrl) URL.revokeObjectURL(shownUrl);
    };
  }, []);
  return <img ref={image} className="nx-sharing-picture" alt="" />;
}
