import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { TitleBar } from "../kit";
import { LogoMark } from "./LogoMark";
import "./WindowMessage.css";

/**
 * A window with nothing to show yet, or nothing it can show: the title bar
 * (so it can still be moved and closed), and a quiet line or two.
 */
export function WindowMessage({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const close = onClose ?? (isTauri() ? () => void getCurrentWindow().close() : undefined);
  return (
    <div className="nx-window">
      <TitleBar leading={<LogoMark />} onClose={close}>
        Linger
      </TitleBar>
      <div className="nx-window-message" role="status">
        {children}
      </div>
    </div>
  );
}
