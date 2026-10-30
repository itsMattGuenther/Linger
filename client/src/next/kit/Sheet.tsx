import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Sheet.css";

/**
 * How something shows over the page on the phone (SPEC §4.15): risen from
 * the bottom, the whole width, over the page dimmed, in a thumb's reach. A
 * held message's actions (a `Menu` with `sheet`), a person's volume and
 * everyone in a big room (a `Popover` with `sheet`, #747) and a report form
 * all rise in this one, so none can be taller than the screen (#776). What
 * it holds scrolls inside it. A tap on the dimmed page closes it; Back is
 * the caller's, since the kit doesn't know the shell.
 */
export function Sheet({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return createPortal(
    <>
      {/* The scrim takes the tap's click, not its press: gone as the finger
          landed, the click would land on whatever was under it (#704). */}
      <div className="k-sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div className="k-sheet" data-kit="Sheet">
        {children}
      </div>
    </>,
    document.body,
  );
}
