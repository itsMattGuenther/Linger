import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../../generated/Attachment";
import { IconButton } from "../../kit";
import "./ImageViewer.css";

/**
 * A picture from the conversation, over the whole window. It lives outside
 * the message row (whose transform would pin it inside the row) and keeps
 * keyboard focus until it closes, then hands it back to what opened it.
 */
export function ImageViewer({ file, url, onClose }: { file: Attachment; url: string; onClose: () => void }) {
  const close = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement;
    close.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className="nx-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          // The close button is the only thing to reach in here.
          event.preventDefault();
          close.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        }
      }}
    >
      <div className="nx-viewer-close" ref={close}>
        <IconButton icon="close" label="Close the picture" shortcut="Esc" tone="filled" onClick={onClose} />
      </div>
      <img className="nx-viewer-image" src={url} alt={file.filename} />
      <p className="nx-viewer-name">{file.filename}</p>
    </div>,
    document.body,
  );
}
