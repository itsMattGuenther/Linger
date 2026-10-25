import { useEffect, useRef } from "react";
import { Button } from "../../kit";
import "./SharingBox.css";

/**
 * Your share, in the voice bar (SPEC §4.20, #360): a small copy of what
 * everybody sees, so you know it's the slide and not your email; who is
 * watching, by name; and Stop. With the share in another of your windows
 * there's no copy here, only the words.
 */
export function SharingBox({ preview, watching, starting, onStop }: { preview: MediaStream | null; watching: string; starting: boolean; onStop: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = preview;
    if (preview) void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [preview]);
  return (
    <div className="nx-sharing" role="group" aria-label="Your screen">
      <div className="nx-sharing-top">
        {preview ? <video ref={video} className="nx-sharing-thumb" muted playsInline aria-hidden="true" /> : null}
        <span className="nx-sharing-words">{starting ? "Starting to share…" : "Sharing your screen"}</span>
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
