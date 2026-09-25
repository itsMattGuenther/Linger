/**
 * Which window a page is (docs/design/architecture.md, "Windows and their
 * roles"). The list is the owner, and only the window the desktop shell
 * labelled `main` may be it: a second owner would open a second connection to
 * every server and tear the first one down. Every other window takes its role
 * from the address the shell built for it (src-tauri/src/window.rs).
 */
import { OWNER } from "./bus";

export type WindowRole = "list" | "chat" | "settings" | "none";

/**
 * `label` is the desktop window's label, or null outside the desktop app (a
 * plain browser, where nothing can be shared and the list is all there is).
 */
export function windowRole(search: string, label: string | null): WindowRole {
  const role = new URLSearchParams(search).get("window");
  if (role === "chat") return label === OWNER ? "none" : "chat";
  if (role === "settings") return label === null || label === "settings" ? "settings" : "none";
  if (role === null && (label === null || label === OWNER)) return "list";
  return "none";
}
