import type { ReactNode } from "react";
import { IconButton } from "./IconButton";
import "./TitleBar.css";

export interface TitleBarProps {
  /** A mark or icon before the title. */
  leading?: ReactNode;
  /** The title (plain text ends in an ellipsis), or a `TabStrip` in a tabbed window. */
  children: ReactNode;
  /** Small `IconButton`s (size md) before the close button, like settings. */
  actions?: ReactNode;
  /** The window has focus: full-strength title. */
  focused?: boolean;
  /** Draws Linger's own close button. Leave it out where the desktop draws one. */
  onClose?: () => void;
  closeLabel?: string;
}

/**
 * The top of every Linger window, drawn by Linger rather than by the system
 * (decided with Matt, 2026-09-25), so it looks the same everywhere. A press
 * anywhere on the bar moves the window, whatever is drawn there (the title,
 * a mark, a `TabStrip`'s empty space, a conversation's header), and controls
 * inside it stay theirs: buttons, links, fields, tabs.
 *
 * That is Tauri's `data-tauri-drag-region="deep"`. A bare
 * `data-tauri-drag-region` counts only for a press on that very element, not
 * on anything inside it, so a bar marked that way is dead wherever its
 * content covers it: the tab row covered all of the chat window's (#225).
 */
export function TitleBar({ leading, children, actions, focused = true, onClose, closeLabel = "Close window" }: TitleBarProps) {
  return (
    <header className="k-titlebar" data-kit="TitleBar" data-focused={focused ? "yes" : "no"} data-tauri-drag-region="deep">
      {leading ? <span className="k-titlebar-lead">{leading}</span> : null}
      <div className="k-titlebar-title">
        {typeof children === "string" ? <span className="k-titlebar-text">{children}</span> : children}
      </div>
      {actions ? <span className="k-titlebar-actions">{actions}</span> : null}
      {onClose ? <IconButton icon="close" label={closeLabel} tone="danger" onClick={onClose} /> : null}
    </header>
  );
}
