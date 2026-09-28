/**
 * Pasting into the message box (#276). A picture on the clipboard becomes a
 * file on the draft, exactly as if it had been added with "Add a file"; words
 * paste as words, as they always have.
 *
 * - **The picture wins.** Some copies carry a picture and words together: a
 *   browser's Copy Image puts the picture's address beside it, and a
 *   spreadsheet puts its cells as words and as a picture. The picture goes on
 *   the draft and the words are left out, as Discord does. A copy that is
 *   only words pastes the words.
 * - **Where the engine shows the paste its files** (Chromium, which is
 *   WebView2 on Windows), they come from the paste event.
 * - **WebKitGTK, the Linux app's engine, never shows the page a picture on
 *   the clipboard**: the paste event has no files, no items and no types for
 *   it (measured on WebKitGTK 2.52.6). So there the box cancels any paste
 *   that carries no files, asks the desktop shell for the picture
 *   (`src-tauri/src/clipboard.rs`, `clipboardImage` below), and puts the
 *   paste's words in itself when there's none.
 * - **A middle-click paste is left to the engine.** It pastes Linux's
 *   selection, not the clipboard, but WebKitGTK fires it with the
 *   clipboard's contents, so asking the shell then would attach whatever
 *   was last copied.
 * - **Nothing empty is ever attached**, and a picture the clipboard gives no
 *   name gets one from when it was pasted (`pasted-image-…png`).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

/** What a paste event carries: the part of `DataTransfer` read here. */
export interface PastedData {
  readonly files: ArrayLike<File>;
  readonly items: ArrayLike<{ readonly kind: string; getAsFile: () => File | null }>;
  getData: (format: string) => string;
}

/** What the box does with a paste. */
export type PastePlan =
  /** Cancel the paste and add these to the draft. */
  | { kind: "files"; files: File[] }
  /** Leave it to the engine: words, or a middle-click paste. */
  | { kind: "engine" }
  /**
   * Cancel it and ask the desktop shell for a picture: attach that if there
   * is one, and otherwise put `words` in (which may be none).
   */
  | { kind: "shell"; words: string };

export interface PasteContext {
  /** The engine can't see pictures on the clipboard, and the desktop shell can (the Linux app). */
  shell: boolean;
  /** A middle-click just pasted the selection. */
  selection: boolean;
  /** When it was pasted, for naming a picture that has no name. */
  at: Date;
}

/**
 * The name Chromium and Firefox give any picture on the clipboard, whatever
 * it is. It says nothing, and every one would have it.
 */
const ENGINE_NAME = "image.png";

/** The files a paste carries, named, with anything empty left out. */
export function pastedFiles(data: PastedData, at: Date): File[] {
  let found = Array.from(data.files);
  // An engine that lists a picture as an item but not as a file.
  if (found.length === 0) {
    found = Array.from(data.items).flatMap((item) => {
      const file = item.kind === "file" ? item.getAsFile() : null;
      return file ? [file] : [];
    });
  }
  let unnamed = 0;
  return found
    .filter((file) => file.size > 0)
    .map((file) => {
      const nameless = file.name === "" || (file.name === ENGINE_NAME && file.type.startsWith("image/"));
      if (!nameless) return file;
      unnamed += 1;
      return new File([file], pastedName(at, file.type, unnamed), { type: file.type, lastModified: file.lastModified });
    });
}

/** What the box does with a paste (see the top of this file). */
export function planPaste(data: PastedData | null, context: PasteContext): PastePlan {
  const files = data ? pastedFiles(data, context.at) : [];
  if (files.length > 0) return { kind: "files", files };
  if (context.selection || !context.shell) return { kind: "engine" };
  return { kind: "shell", words: data?.getData("text/plain") ?? "" };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

const two = (value: number) => String(value).padStart(2, "0");

/**
 * `pasted-image-2026-09-28-143005.png`, in this computer's time; the second
 * and later in one paste get `-2`, `-3`. Sorts by when, and says what it is.
 */
export function pastedName(at: Date, type: string, nth = 1): string {
  const when = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  const again = nth > 1 ? `-${nth}` : "";
  if (!type.startsWith("image/")) return `pasted-file-${when}${again}`;
  return `pasted-image-${when}${again}.${EXTENSIONS[type] ?? "png"}`;
}

/** A PNG's first eight bytes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The shell's answer as a file to attach: its bytes are a PNG, or there was
 * no picture. Anything that isn't a PNG, including nothing, attaches nothing.
 */
export function shellImage(answer: unknown, at: Date): File | null {
  const bytes =
    answer instanceof ArrayBuffer
      ? new Uint8Array(answer)
      : ArrayBuffer.isView(answer)
        ? new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength)
        : Array.isArray(answer) && answer.every((byte) => typeof byte === "number")
          ? Uint8Array.from(answer)
          : null;
  if (!bytes || bytes.length <= PNG_SIGNATURE.length) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  // A copy of its own: the answer's buffer may be shared, and a file keeps its bytes.
  return new File([bytes.slice()], pastedName(at, "image/png"), { type: "image/png" });
}

/** The Linux app's engine, WebKitGTK, which never shows the page a picture on the clipboard. */
export function engineHidesClipboardImages(userAgent: string, desktop: boolean): boolean {
  return desktop && /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent);
}

/** The picture on the clipboard, from the desktop shell, or null when there's none. */
export async function clipboardImage(): Promise<File | null> {
  const answer: unknown = await invoke("clipboard_image");
  return shellImage(answer, new Date());
}

/**
 * The shell's reader for a window whose engine can't see pictures on the
 * clipboard (the Linux app), and nothing anywhere else.
 */
export function clipboardImageReader(): (() => Promise<File | null>) | undefined {
  return engineHidesClipboardImages(navigator.userAgent, isTauri()) ? clipboardImage : undefined;
}
