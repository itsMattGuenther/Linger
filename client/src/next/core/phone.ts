/**
 * Whether this page is the phone app (SPEC §4.15). The phone has one window,
 * the list, and it opens `next.html?shell=phone`
 * (`src-tauri/tauri.android.conf.json`, `tauri.ios.conf.json`); the desktop
 * never adds `shell`. Read from the address rather than guessed from the
 * engine, so a browser test can open the phone's layout at a phone's size.
 */

export function isPhone(search: string): boolean {
  return new URLSearchParams(search).get("shell") === "phone";
}

/** This page, as `isPhone` reads it. */
export function onPhone(): boolean {
  return isPhone(window.location.search);
}

/** What the device is called where a sentence names it. */
export function thisDevice(phone: boolean): string {
  return phone ? "this phone" : "this computer";
}
