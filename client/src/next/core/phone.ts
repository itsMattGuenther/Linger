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

/**
 * How long the phone app may sit in the background before its connections
 * close and it shows offline (SPEC §4.15). Long enough to copy a link
 * elsewhere, which puts Linger in the background too, without you flickering
 * away and back; short enough to come before Android freezes an app it has
 * stopped showing (about a minute, measured on Android 17), after which no
 * timer of ours runs and the server notices only when its heartbeats stop
 * (PROTOCOL, "Heartbeat").
 */
export const BACKGROUND_GRACE_MS = 30_000;

/** The part of `Document` this needs, so tests can hand it a plain one. */
export interface Showing {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Tell `onChange` when the app has been in the background for `graceMs`
 * (true), and when it's back (false). Coming back within the grace says
 * nothing. Answers how to stop.
 */
export function watchBackground(page: Showing, graceMs: number, onChange: (away: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let away = false;
  const settle = () => {
    if (page.visibilityState === "hidden") {
      if (timer === null && !away) {
        timer = setTimeout(() => {
          timer = null;
          away = true;
          onChange(true);
        }, graceMs);
      }
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (away) {
      away = false;
      onChange(false);
    }
  };
  page.addEventListener("visibilitychange", settle);
  settle();
  return () => {
    page.removeEventListener("visibilitychange", settle);
    if (timer !== null) clearTimeout(timer);
  };
}

/** The part of `Window` this needs, so tests can hand it a plain one. */
export interface Online {
  navigator: { onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

/**
 * Tell `onChange` when the phone loses its network (true) and gets one back
 * (false). A phone moves between wifi and mobile data as somebody walks out
 * of a building; reopening the connections the moment there's a network again
 * beats waiting for missed heartbeats to notice (T-1602). Answers how to stop.
 */
export function watchNetwork(page: Online, onChange: (offline: boolean) => void): () => void {
  const lost = () => onChange(true);
  const back = () => onChange(false);
  page.addEventListener("offline", lost);
  page.addEventListener("online", back);
  if (!page.navigator.onLine) onChange(true);
  return () => {
    page.removeEventListener("offline", lost);
    page.removeEventListener("online", back);
  };
}

/**
 * Taller than this, what the page loses to something at the bottom of the
 * screen is the keyboard, not a toolbar coming and going.
 */
export const KEYBOARD_MIN_PX = 150;

/** The part of `VisualViewport` this needs, so tests can hand it a plain one. */
export interface Visible {
  height: number;
  offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

/** Where the phone's styles read the visible part of the page (styles/phone.css). */
export interface Sized {
  style: { setProperty(name: string, value: string): void };
  dataset: Record<string, string | undefined>;
}

/**
 * Keep the page to the part of the screen the keyboard leaves (T-1603). A
 * phone's keyboard covers the page rather than shortening it, and the
 * browser slides the page up under the status bar to show the box being
 * typed in, so the message box ended half under the keyboard and the
 * conversation's header off the top. This follows the visible part instead:
 * where it starts and how tall it is, and whether the keyboard is up.
 * `layoutHeight` is the page's own height. Answers how to stop.
 */
export function followKeyboard(visible: Visible, layoutHeight: () => number, root: Sized): () => void {
  const fit = () => {
    root.style.setProperty("--phone-top", `${Math.round(visible.offsetTop)}px`);
    root.style.setProperty("--phone-height", `${Math.round(visible.height)}px`);
    root.dataset.keyboard = layoutHeight() - visible.height > KEYBOARD_MIN_PX ? "up" : "down";
  };
  visible.addEventListener("resize", fit);
  visible.addEventListener("scroll", fit);
  fit();
  return () => {
    visible.removeEventListener("resize", fit);
    visible.removeEventListener("scroll", fit);
  };
}
