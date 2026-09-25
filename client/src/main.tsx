import { invoke, isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The twelve bundled faces, subset and committed by `scripts/fetch-fonts.sh`.
// First, so every family is declared before anything asks for one.
import "./fonts/fonts.css";
import "./styles/tokens.css";
// The 16 palette colors, generated from linger-core::PALETTE by
// `cargo test -p linger-core`. It comes after the tokens so `[data-theme]`
// stays one continuous block, and before anything that draws a name.
import "./generated/palette.generated.css";
import "./styles/base.css";
import "./styles/names.css";
import App from "./App";
import { applyInterfaceScale } from "./lib/interface";
import { unlockAudio } from "./lib/sound";

applyInterfaceScale();

// WebKitGTK (and other engines) leave AudioContext suspended until a gesture.
// Live chimes arrive from the gateway, which is not a click, so the first
// pointer or key in this window has to open the device.
const armAudio = (): void => {
  unlockAudio();
};
window.addEventListener("pointerdown", armAudio);
window.addEventListener("keydown", armAudio);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tell the desktop shell this window is drawing (#169, `src-tauri/src/graphics.rs`).
// On Linux a launch may be trying WebKit's GPU path, which aborts on some
// computers before anything is drawn; hearing this is how the next launch
// knows this one got through. Two frames, because the first callback runs
// before the first paint.
if (isTauri()) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void invoke("graphics_started").catch(() => undefined);
    }),
  );
}
