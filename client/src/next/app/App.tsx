import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { windowRole } from "../core/role";
import { ChatWindow } from "./chat/ChatWindow";
import { ListWindow } from "./list/ListWindow";
import { SettingsWindow } from "./settings/SettingsWindow";
import { MediaWindow } from "./tools/MediaWindow";
import { SearchWindow } from "./tools/SearchWindow";
import { WindowMessage } from "./WindowMessage";

/** Which window this page is (core/role.ts): only `main` is ever the list, the owner. */
export function App() {
  const role = windowRole(window.location.search, isTauri() ? getCurrentWebviewWindow().label : null);
  if (role === "list") return <ListWindow />;
  if (role === "chat") return <ChatWindow />;
  if (role === "settings") return <SettingsWindow />;
  if (role === "search") return <SearchWindow />;
  if (role === "media") return <MediaWindow />;
  return (
    <WindowMessage>
      <span>This window has nothing to show.</span>
      <span className="nx-window-hint">Close it, and open what you wanted from the list.</span>
    </WindowMessage>
  );
}
