import type { ReactNode } from "react";
import { useBackButton } from "../useBackButton";
import "./Sheet.css";

/**
 * A card risen from the bottom on the phone (SPEC §4.15, #747), over the
 * page dimmed, as the phone's menus are: in a thumb's reach, the whole
 * width. A tap on the dimmed page closes it, as Back does.
 */
export function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useBackButton(true, onClose);
  return (
    <>
      <div className="nx-sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div className="nx-sheet">{children}</div>
    </>
  );
}
