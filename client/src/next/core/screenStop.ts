/**
 * Starting and stopping a share across windows (#360). A share runs in the
 * window where Share was pressed, since the system's picker answers only that
 * window. Stop can be pressed anywhere: the voice bar, a room's voice line in
 * another window, the tray. So Stop stops this window's share and tells every
 * other window to stop theirs; each window that starts a share listens.
 */
import { isTauri } from "@tauri-apps/api/core";
import { showNotice } from "../../lib/notify";
import { BLACK_NOTICE } from "../../lib/screen/black";
import { onShareWentBlack, startSharing, stopSharing } from "../../lib/screen/share";
import { isOwner, OWNER, tauriBus } from "./bus";

export const SCREEN_STOP = "next:screen-stop";
/** A share in another window went black (#722): the list window raises its notice. */
export const SCREEN_BLACK = "next:screen-black";

let listening = false;
let sayingBlack = false;

/**
 * A share gone black says so once on the desktop (#722), and only the list
 * window may raise a notice (`show_notification` is the owner's): a share
 * from a conversation's own window asks it to.
 */
function sayBlack(): void {
  try {
    const bus = tauriBus();
    if (isOwner(bus)) void showNotice(BLACK_NOTICE.title, BLACK_NOTICE.body);
    else void bus.send(OWNER, SCREEN_BLACK, null).catch(() => undefined);
  } catch {
    // No desktop window to say it from.
  }
}

/** In the list window: raise the notice for a share gone black in another window. */
export function hearBlackShares(): () => void {
  if (!isTauri()) return () => undefined;
  let stop: (() => void) | null = null;
  let gone = false;
  void tauriBus()
    .listen<null>(SCREEN_BLACK, () => void showNotice(BLACK_NOTICE.title, BLACK_NOTICE.body))
    .then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    gone = true;
    stop?.();
  };
}

function listen(): void {
  if (listening || !isTauri()) return;
  listening = true;
  void tauriBus()
    .listen<null>(SCREEN_STOP, () => stopSharing())
    .catch(() => {
      listening = false;
    });
}

/**
 * Share from this window: `startSharing`, with this window listening for
 * Stop from the others, and its notice for a share gone black said by the
 * list window. Call it straight from the press.
 */
export function startSharingHere(options: Parameters<typeof startSharing>[0]): Promise<void> {
  const started = startSharing(options);
  listen();
  if (!sayingBlack && isTauri()) {
    sayingBlack = true;
    onShareWentBlack(sayBlack);
  }
  return started;
}

/** Stop sharing, wherever the share runs. */
export function stopSharingEverywhere(): void {
  stopSharing();
  if (isTauri()) void tauriBus().broadcast(SCREEN_STOP, null).catch(() => undefined);
}
