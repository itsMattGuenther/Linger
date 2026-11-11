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

/**
 * Whether the engine is an iPhone's (WebKit on iOS), from its user agent,
 * which names the device; `touchPoints` is the engine's
 * `navigator.maxTouchPoints`. An iPad asking for a computer's page names a
 * Mac instead, and gives itself away by its touch screen, which no Mac has.
 * An iPhone has no Back of its own, so the page goes back with a swipe in
 * from the left edge itself (#697); Android's Back is the phone's, and a
 * swipe of the page's own there would go back twice.
 */
export function isIPhone(userAgent: string, touchPoints: number): boolean {
  return /\b(?:iPhone|iPad|iPod)\b/.test(userAgent) || (/\bMacintosh\b/.test(userAgent) && touchPoints > 1);
}

/** The phone app, on an iPhone. */
export function onIPhone(): boolean {
  return onPhone() && isIPhone(navigator.userAgent, navigator.maxTouchPoints);
}

/**
 * Whether this app can set how loud one person in a call is (#816). The
 * phone plays each voice through the web engine's own player
 * (`lib/pageVoice.ts`), and on an iPhone iOS leaves a player's volume where
 * it is, whatever a page sets: only the phone's own buttons change it. So an
 * iPhone has no per-person volume, rather than a slider that moves and does
 * nothing, and no "mute for you" in its place, which would leave somebody
 * talking to a person who can't hear them (Matt, 2026-11-02).
 */
export function personVolumeWorks(): boolean {
  return !onIPhone();
}

/**
 * Whether this is the Linux app, from its engine's user agent (WebKitGTK
 * names Linux); `shell` is whether the page is in Linger's own shell rather
 * than a browser. Android's engine names Linux too, so it's left out.
 */
export function isLinuxApp(userAgent: string, shell: boolean): boolean {
  return shell && /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent);
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
 * (PROTOCOL, "Heartbeat"). Android 17 on a Pixel also blocks the network of
 * an app that's left the screen, after about five seconds, so there the
 * connections drop sooner and retry into the block until this closes them.
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
 * (true), and when it's back (false). Coming back within the grace tells
 * `onReturn` instead: the connections weren't closed, but Android blocks a
 * background app's network after about five seconds (Android 17 on a Pixel,
 * 2026-10-03), so they may be waiting out a retry that has backed off, and
 * should try again now. `onLeave` hears the moment the app leaves the
 * screen, for what has to be sent while the network is still let through.
 * Answers how to stop.
 */
export function watchBackground(
  page: Showing,
  graceMs: number,
  onChange: (away: boolean) => void,
  onReturn?: () => void,
  onLeave?: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let away = false;
  const settle = () => {
    if (page.visibilityState === "hidden") {
      if (timer === null && !away) {
        onLeave?.();
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
      onReturn?.();
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

/** How far a finger moves before it's dragging, not tapping (#881). */
export const DRAG_PX = 10;

/** Where a field that takes typing is, for `inTextField`. */
const TEXT_FIELD = "textarea, input, [contenteditable]";

/** The part of an element this needs: what it's inside. */
export interface Placed {
  closest(selectors: string): unknown;
}

/** The part of a touch event this needs, so tests can hand it a plain one. */
export interface Fingers {
  target: EventTarget | Placed | null;
  touches: ArrayLike<{ clientX: number; clientY: number }>;
}

/** The part of an element this needs to hear fingers on it. */
export interface Touchable {
  addEventListener(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", listener: (event: Fingers) => void, options: { passive: true }): void;
  removeEventListener(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", listener: (event: Fingers) => void): void;
}

/** Whether `target` is in a field that takes typing, which has the keyboard while it has focus. */
export function inTextField(target: EventTarget | Placed | null): boolean {
  return target !== null && "closest" in target && typeof target.closest === "function" && target.closest(TEXT_FIELD) !== null;
}

/**
 * Put the keyboard away when a finger drags or taps `area` (#881). The
 * iPhone's bar over the keyboard, whose Done did that, is hidden
 * (`src-tauri/src/phone_keyboard.rs`), and as in the phone's own messages
 * app, a finger on the conversation does it instead. `typing` answers the
 * field that has the keyboard, if one has. A finger that starts in a field
 * leaves the keyboard be, since typing goes there, and so does a second
 * finger. A drag puts it away once the finger has moved `DRAG_PX`, a tap
 * once it lifts. Answers how to stop.
 */
export function closeKeyboardOnTouch(area: Touchable, typing: () => { blur(): void } | null): () => void {
  let from: { x: number; y: number } | null = null;
  const close = () => {
    from = null;
    typing()?.blur();
  };
  const start = (event: Fingers) => {
    const finger = event.touches[0];
    from = event.touches.length === 1 && finger && !inTextField(event.target) && typing() ? { x: finger.clientX, y: finger.clientY } : null;
  };
  const move = (event: Fingers) => {
    const finger = event.touches[0];
    if (!from || !finger) return;
    if (event.touches.length > 1) from = null;
    else if (Math.hypot(finger.clientX - from.x, finger.clientY - from.y) >= DRAG_PX) close();
  };
  const end = () => {
    if (from) close();
  };
  const cancel = () => {
    from = null;
  };
  area.addEventListener("touchstart", start, { passive: true });
  area.addEventListener("touchmove", move, { passive: true });
  area.addEventListener("touchend", end, { passive: true });
  area.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    area.removeEventListener("touchstart", start);
    area.removeEventListener("touchmove", move);
    area.removeEventListener("touchend", end);
    area.removeEventListener("touchcancel", cancel);
  };
}

/** An element that can let go of focus, and so of the keyboard. */
interface Blurrable extends Placed {
  blur(): void;
}

function canBlur(element: Placed): element is Blurrable {
  return "blur" in element && typeof element.blur === "function";
}

/** The field on `page` that has the keyboard, if one has (`closeKeyboardOnTouch`). */
export function typingIn(page: { activeElement: Placed | null }): { blur(): void } | null {
  const field = page.activeElement;
  return field && inTextField(field) && canBlur(field) ? field : null;
}

/**
 * The phone's text size as a factor of the usual (`phone_text_scale`: Font
 * size on Android, Text Size on an iPhone), kept to a hundredth and never
 * below 1: a phone set smaller than the usual shrinks nothing of Linger's,
 * and an answer that isn't a number is the usual.
 */
export function textScale(asked: number): number {
  if (!Number.isFinite(asked) || asked <= 1) return 1;
  return Math.round(Math.min(asked, 2) * 100) / 100;
}

/**
 * The phone's text size with Linger's own Text size on top (#690), a
 * percentage chosen in Settings: together never more than twice the usual,
 * as the phone's alone never is.
 */
export function chosenTextScale(phone: number, chosen: number): number {
  return textScale(textScale(phone) * (chosen / 100));
}

/** The part of `Document` that `followTextSize` needs, so tests can hand it a plain one. */
export interface TextPage extends Showing {
  documentElement: { style: { setProperty(name: string, value: string): void } };
}

/**
 * Size the page's text, line boxes, rows and controls by the phone's text
 * size and Linger's own Text size on top of it (`--text-scale`, which the
 * phone's tokens multiply by in styles/tokens.css; #690). The web view's own
 * text zoom is off (MainActivity): it enlarged fonts and line spacing and
 * nothing around them, and cut a name at twice the size in half (2026-10-03,
 * the emulator at its largest Font size). The phone is asked again whenever
 * the app comes back, since its text size is changed in the phone's
 * Settings, away from Linger. `chosen` is Linger's own (`loadTextSize`), read
 * again whenever `changed` hears Settings change it (`onAppearance`). Answers
 * how to stop.
 */
export function followTextSize(
  page: TextPage,
  ask: () => Promise<number>,
  chosen: () => number,
  changed: (listener: () => void) => () => void,
): () => void {
  let gone = false;
  let phone = 1;
  const apply = () => {
    page.documentElement.style.setProperty("--text-scale", String(chosenTextScale(phone, chosen())));
  };
  const measure = () => {
    void ask()
      .catch(() => 1)
      .then((asked) => {
        if (gone) return;
        phone = asked;
        apply();
      });
  };
  const settle = () => {
    if (page.visibilityState === "visible") measure();
  };
  // Linger's own size at once, before the phone has answered.
  apply();
  measure();
  page.addEventListener("visibilitychange", settle);
  const deaf = changed(apply);
  return () => {
    gone = true;
    page.removeEventListener("visibilitychange", settle);
    deaf();
  };
}
