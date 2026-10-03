/**
 * The Buddy list client's entry point (M15, docs/design/architecture.md).
 * Every one of its windows loads `next.html`, which runs this; the window's
 * role comes from the URL. The list owns the sign-in, the connections and
 * the sounds, except a voice control's, which plays in the window where it
 * was pressed (#241).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { followAppearance } from "./core/appearance";
import { followInputMode } from "./core/inputMode";
import { followKeyboard, onPhone } from "./core/phone";
import { refuseStrayDrops } from "../lib/drops";
import { followMediaKeys } from "../lib/mediaKeys";
import { setNoNotifications } from "../lib/notify";
import { unlockAudio } from "../lib/sound";
import { App } from "./app/App";

// Plain names and interface size, the same in every window
// (core/appearance.ts).
followAppearance();

// The phone app's one window (SPEC §4.15, core/phone.ts): its styles keep
// clear of the phone's own bars and cutouts, and of the keyboard
// (styles/phone.css).
if (onPhone()) {
  document.documentElement.dataset.shell = "phone";
  // No notifications on a phone, open or closed (SPEC §4.15).
  setNoNotifications(true);
  if (window.visualViewport) followKeyboard(window.visualViewport, () => window.innerHeight, document.documentElement);
}

// The focus ring is for the keyboard: it follows how you last used the
// window, not what WebKitGTK decides when the window comes back (#375).
followInputMode(document.documentElement, window);

// WebKitGTK leaves an AudioContext suspended until a gesture, and live chimes
// arrive from the gateway rather than from a click. The first pointer or key
// in the window opens the device.
const armAudio = (): void => unlockAudio();
window.addEventListener("pointerdown", armAudio);
window.addEventListener("keydown", armAudio);

// A file dropped anywhere but a drop zone is refused, not opened in place of
// the window (lib/drops.ts).
refuseStrayDrops(window);

// The desktop's play and pause (media keys, MPRIS on Linux, the media
// controls on Windows) resume only what they paused, and never start a song
// you paused yourself (#353, lib/mediaKeys.ts).
followMediaKeys("mediaSession" in navigator ? navigator.mediaSession : undefined, document);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tell the desktop shell this window is drawing (#169, src-tauri/src/graphics.rs,
// docs/design/lessons.md L-13). On Linux a launch may be trying WebKit's GPU
// path, which aborts on some machines before anything is drawn; hearing this
// is how the next launch knows this one got through. Without it every good
// launch looks like a crash and the fast path gets switched off. Two frames,
// because the first callback runs before the first paint.
if (isTauri()) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void invoke("graphics_started").catch(() => undefined);
    }),
  );
}
