/**
 * What closing the list does (decisions 4 and 5, WIN-7): keep Linger running
 * in the tray, the default, so voice and notifications go on; or quit it and
 * every window with it. Kept on this computer. The list window hands it to the
 * desktop shell (`next_close_to_tray`, src-tauri/src/tray.rs), which does the
 * closing; a desktop with no tray quits whatever this says.
 */
import type { ModeStore } from "./conversations";

export type CloseList = "tray" | "quit";

const KEY = "linger.next.closeList";

export function loadCloseList(store: ModeStore | null): CloseList {
  try {
    return store?.getItem(KEY) === "quit" ? "quit" : "tray";
  } catch {
    return "tray";
  }
}

export function saveCloseList(store: ModeStore | null, value: CloseList): void {
  try {
    store?.setItem(KEY, value);
  } catch {
    // Storage refused: this run keeps the choice, the next starts on the tray.
  }
}
