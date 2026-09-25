import { ChatWindow } from "./chat/ChatWindow";
import { ListWindow } from "./list/ListWindow";

/**
 * Which window this page is, from its address (src-tauri/src/window.rs): the
 * chat window is opened with `?window=chat`; the list, the owner, with none.
 */
export function App() {
  const role = new URLSearchParams(window.location.search).get("window");
  return role === "chat" ? <ChatWindow /> : <ListWindow />;
}
