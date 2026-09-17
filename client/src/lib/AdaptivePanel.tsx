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
  const previousLayout = useRef(collapsed);
  const lastFocus = useRef<HTMLElement | null>(null);
  const label = side === "rail" ? "Navigation" : "People";
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const layoutChanged = previousLayout.current !== collapsed;
    previousLayout.current = collapsed;
    const heldFocus =
      node.contains(document.activeElement) ||
      document.activeElement === document.body;
    if (layoutChanged && node.open) node.close();
    if (!collapsed) {
      // A non-modal, presentational wrapper keeps child state (including
      // unsaved status text) mounted while the layout changes around it.
      node.setAttribute("open", "");
      if (layoutChanged && open && heldFocus) {
        const target = lastFocus.current;
        if (target?.isConnected) target.focus();
        else node.querySelector<HTMLElement>("aside button")?.focus();
      }
      return;
    }
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
    if (layoutChanged && !open && lastFocus.current && heldFocus) {
      document
        .querySelector<HTMLButtonElement>(
          side === "rail" ? ".navigation-access" : ".people-access",
        )
        ?.focus();
    }
  }, [collapsed, open, side]);

  return (
    <dialog
      ref={dialog}
      id={`${side}-drawer`}
      className={
        collapsed ? `panel-drawer panel-drawer-${side}` : "panel-inline"
      }
      role={collapsed ? "dialog" : "presentation"}
      aria-labelledby={collapsed ? `${side}-drawer-title` : undefined}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement)
          lastFocus.current = event.target;
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (!collapsed || event.key !== "Tab") return;
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
        if (!collapsed || event.target !== event.currentTarget) return;
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
      {collapsed ? (
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
      ) : null}
      {children}
    </dialog>
  );
}
