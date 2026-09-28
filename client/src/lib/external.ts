/**
 * Opening a link somebody put in a message.
 *
 * It goes to the system browser, never to this window. A WebView that navigates
 * itself to a URL out of a chat message has replaced the application with a
 * website, taking the signed-in session with it — so the app never follows a
 * link, it hands it over.
 *
 * The URL has already been through `safeHref` in `lib/markdown.ts`, which is
 * how it became a link at all, and the Tauri capability in
 * `src-tauri/capabilities/default.json` narrows the plugin to http and https on
 * the Rust side. Two locks on the door, because the input is a message body and
 * message bodies are hostile (ARCHITECTURE §7).
 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(href: string): void {
  // Ordinary links retain their quiet behavior. Downloads use the checked
  // form below so a refused handoff cannot look like a completed save.
  void openExternalChecked(href).catch(() => undefined);
}

/** Report a refused handoff without treating browser launch as a finished download. */
export async function openExternalChecked(href: string): Promise<void> {
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web addresses can be opened.");
  }
  if (isTauri()) {
    await openUrl(href);
    return;
  }
  // `pnpm dev` in a plain browser, where there is no shell to hand it to.
  // With noreferrer, browsers return null even for an allowed new window.
  // The caller must not infer either a saved file or a blocked popup from it.
  window.open(href, "_blank", "noreferrer");
}
