import { type ReactNode, useLayoutEffect, useRef } from "react";

/** Keep the same panel reachable when the window cannot fit another column. */
export default function AdaptivePanel({
  side,
  collapsed,
  open,
  onClose,
  children,
}: {
  side: "rail" | "roster";
  collapsed: boolean;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = side === "rail" ? "Navigation" : "People";
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [collapsed, open]);

  if (!collapsed) return children;
  return (
    <dialog
      ref={dialog}
      id={`${side}-drawer`}
      className={`panel-drawer panel-drawer-${side}`}
      aria-labelledby={`${side}-drawer-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
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
      <header className="panel-drawer-head">
        <h2 id={`${side}-drawer-title`}>{label}</h2>
        <button
          type="button"
          className="rail-action"
          onClick={onClose}
          autoFocus
          aria-label={`Close ${label.toLowerCase()}`}
        >
          Close
        </button>
      </header>
      {children}
    </dialog>
  );
}
