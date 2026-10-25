/**
 * Starting and stopping a share across windows (#360). A share runs in the
 * window where Share was pressed, since the system's picker answers only that
 * window. Stop can be pressed anywhere: the voice bar, a room's voice line in
 * another window, the tray. So Stop stops this window's share and tells every
 * other window to stop theirs; each window that starts a share listens.
 */
import { isTauri } from "@tauri-apps/api/core";
import { startSharing, stopSharing } from "../../lib/screen/share";
import { tauriBus } from "./bus";

export const SCREEN_STOP = "next:screen-stop";

let listening = false;

function listen(): void {
  if (listening || !isTauri()) return;
  listening = true;
  void tauriBus()
    .listen<null>(SCREEN_STOP, () => stopSharing())
    .catch(() => {
      listening = false;
    });
}

/** Share from this window: `startSharing`, with this window listening for Stop from the others. Call it straight from the press. */
export function startSharingHere(options: Parameters<typeof startSharing>[0]): Promise<void> {
  const started = startSharing(options);
  listen();
  return started;
}

/** Stop sharing, wherever the share runs. */
export function stopSharingEverywhere(): void {
  stopSharing();
  if (isTauri()) void tauriBus().broadcast(SCREEN_STOP, null).catch(() => undefined);
}
