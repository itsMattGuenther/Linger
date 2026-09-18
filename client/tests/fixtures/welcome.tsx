/** Desktop welcome state; no saved accounts or network requests are used. */
import { createRoot } from "react-dom/client";
import AuthScreens from "../../src/auth/AuthScreens";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
const unavailable = new URLSearchParams(location.search).has("unavailable");
createRoot(root).render(
  <AuthScreens
    notice={null}
    keyringNotice={
      unavailable ? "Your computer's secure storage is unavailable." : null
    }
    onAuthenticated={async () => {}}
  />,
);
