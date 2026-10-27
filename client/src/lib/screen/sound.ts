import { useSyncExternalStore } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { readSound } from "./frames";

/**
 * The computer's sound in a screen share (SPEC §4.20, PROTOCOL §8, #736),
 * the parts both ends keep: the sharer's switch, the watcher's sound button
 * and volume, each remembered on this computer, and the shell's capture.
 *
 * The sound is captured by the desktop shell, never by the web engine: the
 * engine's own capture of the computer's sound would take in Linger's voice
 * call too, and send everybody's voices back to them, late. The shell's
 * leaves out everything Linger plays (`src-tauri/src/screen_sound.rs`). Only
 * the Windows app captures for now; Linux needs Linger's own streams left out
 * of PipeWire's graph first.
 */

/** A remembered on/off, with its listeners. */
function remembered(key: string, fallback: boolean): { get: () => boolean; set: (on: boolean) => void; use: () => boolean } {
  const read = (): boolean => {
    try {
      const held = localStorage.getItem(key);
      return held === null ? fallback : held === "on";
    } catch {
      return fallback;
    }
  };
  let now = read();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get: () => now,
    set: (on) => {
      now = on;
      try {
        if (on === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, on ? "on" : "off");
      } catch {
        // Not kept; it still holds until the app closes.
      }
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, () => now),
  };
}

/** "Share the computer's sound", off until it's turned on, then kept on this computer. */
const shareSound = remembered("linger.next.shareSound", false);
export const shareSoundOn = shareSound.get;
export const setShareSoundOn = shareSound.set;
export const useShareSoundOn = shareSound.use;

/** A watcher's sound button, on until it's turned off, then kept on this computer. */
const watchSound = remembered("linger.next.watchSound", true);
export const watchSoundOn = watchSound.get;
export const useWatchSoundOn = watchSound.use;
const soundListeners = new Set<(on: boolean) => void>();

/** Turn a watched screen's sound on or off, here and for every screen from now on. */
export function setWatchSoundOn(on: boolean): void {
  watchSound.set(on);
  for (const listener of soundListeners) listener(on);
}

/** Told when the sound button changes, for the watch running. */
export function onWatchSound(listener: (on: boolean) => void): () => void {
  soundListeners.add(listener);
  return () => soundListeners.delete(listener);
}

/** How loud a watched screen's sound plays, 0 to 1, kept on this computer. */
const VOLUME_KEY = "linger.next.watchVolume";
let volumeNow = readVolume();
const volumeListeners = new Set<() => void>();

function readVolume(): number {
  try {
    const held = Number(localStorage.getItem(VOLUME_KEY) ?? "1");
    return Number.isFinite(held) ? Math.min(1, Math.max(0, held)) : 1;
  } catch {
    return 1;
  }
}

export function watchVolume(): number {
  return volumeNow;
}

export function useWatchVolume(): number {
  return useSyncExternalStore(
    (listener) => {
      volumeListeners.add(listener);
      return () => volumeListeners.delete(listener);
    },
    () => volumeNow,
  );
}

export function setWatchVolume(volume: number): void {
  volumeNow = Math.min(1, Math.max(0, volume));
  try {
    if (volumeNow === 1) localStorage.removeItem(VOLUME_KEY);
    else localStorage.setItem(VOLUME_KEY, String(volumeNow));
  } catch {
    // Not kept; it still holds until the app closes.
  }
  for (const listener of volumeListeners) listener();
}

/** For tests: read what's kept again. */
export function forgetSoundPrefs(): void {
  volumeNow = readVolume();
}

/** Whether this page is a desktop app's, whose shell captures and plays sound; never the phone's (`?shell=phone`). */
export function desktopShell(): boolean {
  return isTauri() && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("shell") !== "phone";
}

/** Whether this app can capture the computer's sound: null until the shell has said. Asked once. */
let captures: boolean | null = null;
let asking = false;
const captureListeners = new Set<() => void>();

/**
 * Whether this app can share the computer's sound: the desktop shell says,
 * and only Windows 10 2004 or later can (`screen_sound_available`).
 * False, without asking, outside a desktop app.
 */
export function capturesSound(): boolean | null {
  if (!desktopShell()) return false;
  if (captures === null && !asking) {
    asking = true;
    invoke<unknown>("screen_sound_available").then(
      (said) => settleCaptures(said === true),
      () => settleCaptures(false),
    );
  }
  return captures;
}

function settleCaptures(said: boolean): void {
  captures = said;
  for (const listener of captureListeners) listener();
}

function onCapturesAnswer(listener: () => void): () => void {
  captureListeners.add(listener);
  return () => captureListeners.delete(listener);
}

/** `capturesSound`, for a screen, drawn again once the shell has said; false without asking until `wanted`. */
export function useCapturesSound(wanted: boolean): boolean {
  return useSyncExternalStore(onCapturesAnswer, () => (wanted ? capturesSound() === true : false));
}

/** For tests: ask the shell again. */
export function forgetCaptures(): void {
  captures = null;
  asking = false;
}

/** The computer's sound being captured for a share: its packets, wire-shaped, stamped on the shell's clock. */
export interface SoundCapture {
  onPacket: (packet: ArrayBuffer) => void;
  /** It stopped by itself; the share carries on without it. */
  onEnded: () => void;
  stop(): void;
}

/** Start capturing the computer's sound, through the shell; null when it can't. */
export async function captureSound(): Promise<SoundCapture | null> {
  if (!desktopShell()) return null;
  const capture: SoundCapture = {
    onPacket: () => undefined,
    onEnded: () => undefined,
    stop: () => void invoke("screen_sound_stop").catch(() => undefined),
  };
  const sounds = new Channel<unknown>((packet) => {
    if (packet instanceof ArrayBuffer && readSound(packet)) capture.onPacket(packet);
  });
  const says = new Channel<unknown>((said) => {
    if (typeof said === "object" && said !== null && "op" in said && said.op === "ended") capture.onEnded();
  });
  try {
    await invoke("screen_sound_start", { sounds, says });
    return capture;
  } catch {
    return null;
  }
}
