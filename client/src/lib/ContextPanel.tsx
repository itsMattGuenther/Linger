import { type ReactNode, useLayoutEffect, useRef } from "react";
import IconButton from "./IconButton";
import { ActionIcon } from "./icons";

/** Keep contextual controls beside their source, inside the viewport and out of scrollers. */
export default function ContextPanel({
  anchor,
  label,
  side = "below",
  variant = "dialog",
  onClose,
  children,
  className = "",
}: {
  anchor: HTMLElement;
  label: string;
  side?: "left" | "below" | "above";
  variant?: "dialog" | "menu";
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // `showModal()` moves real focus into the panel. Keep that focus for
    // screen readers and immediate keyboard use, but a pointer-opened panel
    // should not pretend somebody already navigated to its first control.
    // Capture the opener's focus-visible state before the dialog takes focus.
    node.toggleAttribute("data-quiet-focus", !anchor.matches(":focus-visible"));
    node.showModal();
    const place = () => {
      const source = anchor.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const left =
        side === "left"
          ? source.left - box.width - 12
          : side === "above"
            ? source.left
            : source.right - box.width;
      const above = source.top - box.height - 8;
      const top = side === "left"
        ? source.top
        : side === "above" && above >= 8 ? above : source.bottom + 8;
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
      className={`context-panel ${variant === "menu" ? "context-menu" : ""} ${className}`}
      role={variant}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        const menuArrow = variant === "menu" &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key);
        if (event.key !== "Tab" && !menuArrow) return;
        event.currentTarget.removeAttribute("data-quiet-focus");
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
        if (menuArrow) {
          event.preventDefault();
          const index = controls.findIndex((node) => node === document.activeElement);
          if (event.key === "Home") first?.focus();
          else if (event.key === "End") last?.focus();
          else {
            const step = event.key === "ArrowDown" ? 1 : -1;
            controls[(index + step + controls.length) % controls.length]?.focus();
          }
        } else if (event.shiftKey && document.activeElement === first) {
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
      {variant === "dialog" ? (
        <IconButton
          label={`Close ${label}`}
          className="context-close"
          tooltipSide="below"
          onClick={onClose}
          autoFocus
        >
          <ActionIcon name="close" />
        </IconButton>
      ) : null}
      {children}
    </dialog>
  );
}
