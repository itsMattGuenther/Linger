import { type ReactNode, useLayoutEffect, useRef } from "react";
import IconButton from "./IconButton";
import { ActionIcon } from "./icons";

/** Keep contextual controls beside their source, inside the viewport and out of scrollers. */
export default function ContextPanel({
  anchor,
  label,
  side = "below",
  onClose,
  children,
  className = "",
}: {
  anchor: HTMLElement;
  label: string;
  side?: "left" | "below";
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    const place = () => {
      const source = anchor.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const left =
        side === "left"
          ? source.left - box.width - 12
          : source.right - box.width;
      const top = side === "left" ? source.top : source.bottom + 8;
      node.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      node.close();
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [anchor, side]);

  return (
    <dialog
      ref={dialog}
      className={`context-panel ${className}`}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        // A profile can be inside the narrow-window People dialog. Only the
        // top panel owns Tab; the parent's focus loop must not intercept it.
        event.stopPropagation();
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
          ),
        ].filter((node) => node.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <IconButton
        label={`Close ${label}`}
        className="context-close"
        tooltipSide="below"
        onClick={onClose}
        autoFocus
      >
        <ActionIcon name="close" />
      </IconButton>
      {children}
    </dialog>
  );
}
