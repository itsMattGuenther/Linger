import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { onPhone } from "../core/phone";
import { minimizer } from "../core/windowControls";
import { TitleBar } from "../kit";
import { LogoMark } from "./LogoMark";
import "./WindowMessage.css";

/**
 * A window with nothing to show yet, or nothing it can show: the title bar
 * (so it can still be moved and closed), and a quiet line or two. A phone's
 * one window has no close button of its own: the app is closed the phone's
 * way (SPEC §4.15).
 */
export function WindowMessage({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const close = onClose ?? (isTauri() && !onPhone() ? () => void getCurrentWindow().close() : undefined);
  return (
    <div className="nx-window">
      <TitleBar leading={<LogoMark />} onMinimize={minimizer()} onClose={close}>
        Linger
      </TitleBar>
      <div className="nx-window-message" role="status">
        {children}
      </div>
    </div>
  );
}
