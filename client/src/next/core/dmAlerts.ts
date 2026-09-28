/**
 * DM alerts (#291): a desktop banner for every DM, and the taskbar pointing
 * at Linger until you look. A DM is addressed to you, as a mention is, so it
 * is on unless somebody turns it off, on this computer (Settings →
 * Notifications). The list window reads it on every DM (`lib/notify.ts`), so
 * no window has to tell another when it changes.
 */

const KEY = "linger.next.dmAlerts";

export function loadDmAlerts(store: Pick<Storage, "getItem"> | null): boolean {
  try {
    return store?.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveDmAlerts(store: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    store?.setItem(KEY, on ? "true" : "false");
  } catch {
    // Storage refused: the choice lasts for this run.
  }
}
