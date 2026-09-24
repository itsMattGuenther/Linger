import { type ReactNode, useLayoutEffect, useRef } from "react";
import IconButton from "./IconButton";
import { ActionIcon } from "./icons";

/**
 * How the person last reached for the app: a press of a pointer or of a key.
 *
 * A panel needs to know whether it was opened by mouse or keyboard, and asking
 * the browser whether the opener "matches :focus-visible" is not a reliable
 * answer — engines disagree, most of all after a script has handed focus back
 * to the opener when the previous panel closed (#96, #143). The input that
 * actually happened last is. Captured on `window` so nothing can stop it first.
 */
let lastInput: "pointer" | "keyboard" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => { lastInput = "pointer"; }, { capture: true, passive: true });
  window.addEventListener("keydown", () => { lastInput = "keyboard"; }, { capture: true });
}

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
    // `showModal()` moves real focus into the panel. A keyboard-opened panel
    // puts it on the close button, where the ring and its name show at once.
    // A pointer-opened one must not look as if somebody tabbed there (#143):
    // a dialog panel takes focus on itself, so screen readers still land in it
    // and Tab starts at its first control, and a menu keeps focus on its first
    // item but draws it quietly until the keyboard is used.
    const byKeyboard = lastInput === "keyboard";
    node.toggleAttribute("data-quiet-focus", !byKeyboard);
    node.showModal();
    if (variant === "dialog") {
      if (byKeyboard) node.querySelector<HTMLElement>(".context-close")?.focus();
      else node.focus({ preventScroll: true });
    }
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
  }, [anchor, side, variant]);

  return (
    <dialog
      ref={dialog}
      className={`context-panel ${variant === "menu" ? "context-menu" : ""} ${className}`}
      role={variant}
      aria-label={label}
      tabIndex={-1}
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
        if (!menuArrow && document.activeElement === event.currentTarget) {
          // Focus is on the panel itself, after a pointer open: Tab enters at
          // the first control and Shift+Tab at the last, never out of it.
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (menuArrow) {
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
        >
          <ActionIcon name="close" />
        </IconButton>
      ) : null}
      {children}
    </dialog>
  );
}
