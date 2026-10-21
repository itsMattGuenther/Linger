import { type PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../../generated/Attachment";
import { fileNameToShow } from "../../../lib/media";
import { type Layout, startZoom, type View } from "../../core/zoom";
import { IconButton } from "../../kit";
import "./ImageViewer.css";
import { useBackButton } from "../useBackButton";

/**
 * Where the picture sits before it's zoomed. Its element's offsets aren't
 * moved by the zoom's transform, or by the glide back from one, so this is
 * right even partway through; the viewer covers the window from its
 * top-left corner, so they're the page's too.
 */
function laidOut(image: HTMLImageElement | null): Layout | null {
  const viewer = image?.offsetParent;
  if (!image || !(viewer instanceof HTMLElement) || !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) return null;
  const width = image.offsetWidth;
  const height = image.offsetHeight;
  const drawn = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const box = { left: image.offsetLeft, top: image.offsetTop };
  return {
    box,
    picture: {
      left: box.left + (width - image.naturalWidth * drawn) / 2,
      top: box.top + (height - image.naturalHeight * drawn) / 2,
      width: image.naturalWidth * drawn,
      height: image.naturalHeight * drawn,
    },
    screen: { width: viewer.clientWidth, height: viewer.clientHeight },
  };
}

function draw(image: HTMLImageElement | null, view: View, glide: boolean) {
  if (!image) return;
  image.classList.toggle("nx-viewer-image-glide", glide);
  image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/**
 * A picture from the conversation, over the whole window. It lives outside
 * the message row (whose transform would pin it inside the row) and keeps
 * keyboard focus until it closes, then hands it back to what opened it.
 *
 * Fingers zoom it (core/zoom.ts), since the phone's page never zooms
 * (#689): pinch, drag, and a double tap in and out. A finger's tap closes
 * it once it isn't the first of two, so its click is let go; a mouse's
 * click closes it at once, as it always has.
 */
export function ImageViewer({ file, url, onClose }: { file: Attachment; url: string; onClose: () => void }) {
  const close = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const name = fileNameToShow(file.filename);
  // The original that can't be loaded says so, not the engine's broken-picture icon (#512).
  const [failed, setFailed] = useState(false);
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  const [zoom] = useState(() =>
    startZoom(
      () => laidOut(picture.current),
      (view, glide) => draw(picture.current, view, glide),
      () => closeNow.current(),
    ),
  );
  // The last press came from a finger, so its click was the zoom's to deal with.
  const touched = useRef(false);
  // Android's Back closes the picture first (SPEC §4.15).
  useBackButton(true, onClose);
  useEffect(() => {
    const opener = document.activeElement;
    close.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  // A window that changes size lays the picture out again, unzoomed.
  useEffect(() => {
    const reset = () => zoom.reset();
    window.addEventListener("resize", reset);
    return () => {
      window.removeEventListener("resize", reset);
      zoom.stop();
    };
  }, [zoom]);

  // A finger on the close button is the button's.
  const fingered = (event: PointerEvent) =>
    event.pointerType !== "mouse" && !(event.target instanceof Element && event.target.closest("button") !== null);

  return createPortal(
    <div
      className="nx-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={() => {
        if (!touched.current) onClose();
      }}
      onPointerDown={(event) => {
        touched.current = event.pointerType !== "mouse";
        if (fingered(event)) zoom.down(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (fingered(event)) zoom.move(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (fingered(event)) zoom.up(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerCancel={(event) => zoom.cancel(event.pointerId)}
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
      {failed ? (
        <p className="nx-viewer-failed" role="alert">
          Couldn't load this picture.
        </p>
      ) : (
        <img ref={picture} className="nx-viewer-image" src={url} alt={name} onError={() => setFailed(true)} />
      )}
      <p className="nx-viewer-name">{name}</p>
      {/* After the picture, so a zoomed one never covers it. */}
      <div className="nx-viewer-close" ref={close}>
        <IconButton icon="close" label="Close the picture" shortcut="Esc" tone="filled" onClick={onClose} />
      </div>
    </div>,
    document.body,
  );
}
