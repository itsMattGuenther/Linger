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

applyInterfaceScale();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
