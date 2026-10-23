/**
 * Getting a shared file out of the app (FILE-6, SPEC §4.10). On a computer,
 * and on Android, whose Chrome saves it, a download is handed to the browser
 * (`lib/external.ts`). On an iPhone Safari, handed a download by another app,
 * opened a blank tab and seemed to do nothing (#703), so there the shell
 * fetches the file itself and shows the iPhone's share sheet for it, with
 * Save to Files, AirDrop and opening it in another app
 * (`src-tauri/src/phone_save.rs`). Either way the file's bytes never pass
 * through this page.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { checkWebAddress, openExternalChecked } from "../../lib/external";
import { onIPhone } from "./phone";

/** Where a download goes: the browser, or the iPhone's share sheet. */
export type DownloadWay = "browser" | "sheet";

/**
 * The way here: the share sheet in the iPhone app, the browser everywhere
 * else, a page in a plain browser on an iPhone included, which has no shell
 * to fetch it.
 */
export function downloadWay(iPhone: boolean = onIPhone(), shell: boolean = isTauri()): DownloadWay {
  return iPhone && shell ? "sheet" : "browser";
}

/** A file on its way, which only an iPhone takes long enough to say: Media's line, and its button's name meanwhile. */
export function gettingLine(title: string): string {
  return `Getting ${title}…`;
}

/** What Media's line says when a file didn't come. Its message has the file's card, whose address can be copied. */
export function downloadFailedLine(way: DownloadWay, title: string): string {
  return way === "sheet" ? `Couldn't get ${title}. Try again, or open its message for its address.` : `Couldn't open your browser for ${title}. Try again.`;
}

/**
 * Download one file: `href` is its address on the server's media origin,
 * `filename` what it's called, which the shell makes safe for a file's name.
 * Resolves once the browser has it, or the share sheet is showing; rejects
 * when neither happened, so the caller can offer another go and the address.
 */
export async function downloadFile(href: string, filename: string, way: DownloadWay = downloadWay()): Promise<void> {
  if (way === "browser") {
    await openExternalChecked(href);
    return;
  }
  checkWebAddress(href);
  await invoke("phone_save", { url: href, name: filename });
}
