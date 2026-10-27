import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ScreenFps } from "./presets";

/**
 * A screen shared through the desktop shell (#360, SPEC §4.20, T-1907). On
 * Linux the shell asks the desktop's screen-sharing portal for the screen and
 * encodes it with the system's GStreamer (`src-tauri/src/screen_shell.rs`):
 * WebKitGTK reads a shared screen only as GPU buffers, and on many computers
 * can't turn those into pictures. This gives `share.ts` the shell's frames,
 * already in the screen socket's shape (`frames.ts`), and passes on what the
 * share asks of the shell: a key frame, and stop.
 */

/** Why the shell gave no screen: the picker closed, none given, or none it can encode. */
export type ShellRefused = "declined" | "no-screen" | "no-encoder";

export interface ShellCapture {
  /** Each frame, as the screen socket sends it. */
  onFrame: (frame: ArrayBuffer) => void;
  /** Each of the preview's pictures, a JPEG, a few a second while it's shown. */
  onPicture: (picture: ArrayBuffer) => void;
  /** It ended by itself: the screen went, or it couldn't be read. */
  onEnded: (why: "gone" | "failed") => void;
  /** About once a second: whether the share is black (`black.ts`). */
  onLooked: (black: boolean) => void;
  keyframe(): void;
  /** Show the preview or hide it; hidden, the shell stops making it. */
  preview(shown: boolean): void;
  stop(): void;
}

/** Whether this is the Linux app, which shares through its shell and only so. */
export function sharesThroughShell(): boolean {
  if (!isTauri() || typeof navigator === "undefined") return false;
  return /\bLinux\b/.test(navigator.userAgent) && !/\bAndroid\b/.test(navigator.userAgent);
}

/** Whether the shell can share a screen here: null until it has said. Asked once. */
let available: boolean | null = null;
let asking = false;
const listeners = new Set<() => void>();

export function shellShares(): boolean | null {
  if (!sharesThroughShell()) return false;
  if (available === null && !asking) {
    asking = true;
    invoke<unknown>("screen_share_available").then(
      (said) => settle(said === true),
      () => settle(false),
    );
  }
  return available;
}

function settle(said: boolean): void {
  available = said;
  for (const listener of listeners) listener();
}

/** Told when the shell has said whether it shares. */
export function onShellAnswer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let plays: Promise<boolean> | null = null;

/**
 * Whether WebKit can play a shared screen here (#729); true away from the
 * Linux app. Where the shell has WebKit draw without the GPU (`GDK_GL=disable`
 * on NVIDIA's legacy driver, #229), WebKitGTK's WebCodecs aborts the page
 * the moment it builds a decoder, `isConfigSupported` included, and nothing a
 * page can try shows it first: WebGL still works there. The shell knows what
 * it set, so it's asked, once. No answer counts as no: a wrong yes costs the
 * window.
 */
export function shellPlays(): Promise<boolean> {
  if (!sharesThroughShell()) return Promise.resolve(true);
  plays ??= invoke<unknown>("screen_watch_available").then(
    (said) => said === true,
    () => false,
  );
  return plays;
}

/** For tests: ask again. */
export function forgetShell(): void {
  available = null;
  asking = false;
  plays = null;
}

function refusal(error: unknown): ShellRefused {
  return error === "declined" || error === "no-encoder" ? error : "no-screen";
}

/** A look at the share, `{ op: "looks", black }`, or null for anything else. */
function looked(said: unknown): boolean | null {
  if (typeof said !== "object" || said === null || !("op" in said) || said.op !== "looks" || !("black" in said)) return null;
  return said.black === true;
}

function ended(said: unknown): "gone" | "failed" | null {
  if (typeof said !== "object" || said === null || !("op" in said) || said.op !== "ended" || !("why" in said)) return null;
  return said.why === "gone" ? "gone" : "failed";
}

/**
 * Share a screen at `fps` through the shell, its preview `shown` or not:
 * the desktop's picker opens, and this resolves once something is picked,
 * or with why not.
 */
export async function captureInShell(fps: ScreenFps, shown: boolean): Promise<ShellCapture | ShellRefused> {
  const capture: ShellCapture = {
    onFrame: () => undefined,
    onPicture: () => undefined,
    onEnded: () => undefined,
    onLooked: () => undefined,
    keyframe: () => void invoke("screen_share_keyframe").catch(() => undefined),
    preview: (on) => void invoke("screen_share_preview", { shown: on }).catch(() => undefined),
    stop: () => void invoke("screen_share_stop").catch(() => undefined),
  };
  const frames = new Channel<unknown>((frame) => {
    if (frame instanceof ArrayBuffer) capture.onFrame(frame);
  });
  const pictures = new Channel<unknown>((picture) => {
    if (picture instanceof ArrayBuffer) capture.onPicture(picture);
  });
  const says = new Channel<unknown>((said) => {
    const black = looked(said);
    if (black !== null) {
      capture.onLooked(black);
      return;
    }
    const why = ended(said);
    if (why) capture.onEnded(why);
  });
  try {
    await invoke("screen_share_start", { fps, shown, frames, pictures, says });
    return capture;
  } catch (error) {
    return refusal(error);
  }
}
