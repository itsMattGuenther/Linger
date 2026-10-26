import { useEffect, useRef } from "react";
import { onPreviewPicture, type ScreenShareState, setPreviewShown, usePreviewShown } from "../../../lib/screen/share";
import { Button, IconButton } from "../../kit";
import "./SharingBox.css";

/** Where your share's preview comes from: the page's own picture of it, or the shell's (Linux). */
export type SharePreview = { kind: "stream"; stream: MediaStream } | { kind: "pictures" };

/** Your share's preview, from this window's share: its own picture, or the shell's pictures. */
export function previewOf(here: ScreenShareState): SharePreview | null {
  if (here.preview) return { kind: "stream", stream: here.preview };
  return here.pictures ? { kind: "pictures" } : null;
}

/** What the box shows: your share, as this window has it. */
export interface SharingBoxProps {
  preview: SharePreview | null;
  /** Who is watching, in words. */
  watching: string;
  starting: boolean;
  onStop: () => void;
}

/**
 * Your share, in the voice bar (SPEC §4.20, #360): a copy of what everybody
 * sees, so you know it's the slide and not your email; who is watching, by
 * name; and Stop. The eye hides the copy and shows it again, kept for next
 * time: hidden, it's no work for the computer. With the share in another of
 * your windows there's no copy here, only the words. In the list's voice bar
 * it's a box; under a popped-out conversation's voice line, which has no
 * voice bar, a band: the copy beside the words, and hidden, one line.
 */
export function SharingBox({ preview, watching, starting, onStop, layout = "bar" }: SharingBoxProps & { layout?: "bar" | "band" }) {
  const shown = usePreviewShown();
  const words = <span className="nx-sharing-words">{starting ? "Starting to share…" : "Sharing your screen"}</span>;
  const eye = preview ? <IconButton icon="preview" label="Show the preview" size="sm" pressed={shown} onClick={() => setPreviewShown(!shown)} /> : null;
  const stop = (
    <Button size="sm" variant="secondary" onClick={onStop}>
      Stop
    </Button>
  );
  const who = (
    <p className="nx-sharing-who" role="status">
      {watching}
    </p>
  );
  if (layout === "band") {
    const copy = preview && shown ? <div className="nx-sharing-preview">{preview.kind === "stream" ? <StreamPreview stream={preview.stream} /> : <PicturePreview />}</div> : null;
    return (
      <div className="nx-sharing" data-layout="band" data-copy={copy ? "shown" : "hidden"} role="group" aria-label="Your screen">
        {copy ? (
          <>
            {copy}
            <div className="nx-sharing-side">
              <div className="nx-sharing-top">
                {words}
                {eye}
                {stop}
              </div>
              {who}
            </div>
          </>
        ) : (
          <>
            {words}
            {who}
            {eye}
            {stop}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="nx-sharing" role="group" aria-label="Your screen">
      {preview && shown ? (
        <div className="nx-sharing-preview">{preview.kind === "stream" ? <StreamPreview stream={preview.stream} /> : <PicturePreview />}</div>
      ) : null}
      <div className="nx-sharing-top">
        {words}
        {eye}
        {stop}
      </div>
      {who}
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
