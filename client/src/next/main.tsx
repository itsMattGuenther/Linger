/**
 * The Buddy list client's entry point (M15, docs/design/architecture.md).
 * Every one of its windows loads `next.html`, which runs this; the window's
 * role comes from the URL. Today there is one: the list, which owns the
 * sign-in, the connections and the sounds.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { applyInterfaceScale } from "../lib/interface";
import { unlockAudio } from "../lib/sound";
import { App } from "./app/App";

// The reader's interface size, kept under the same key as today's client, so
// switching clients keeps it.
applyInterfaceScale();

// WebKitGTK leaves an AudioContext suspended until a gesture, and live chimes
// arrive from the gateway rather than from a click. The first pointer or key
// in the window opens the device.
const armAudio = (): void => unlockAudio();
window.addEventListener("pointerdown", armAudio);
window.addEventListener("keydown", armAudio);

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
