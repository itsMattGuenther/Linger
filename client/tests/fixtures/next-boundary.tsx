/**
 * The last place a drawing error is caught (#509, `src/next/app/Boundary.tsx`):
 * a window's root, drawn as `main.tsx` draws every window, around a part that
 * breaks on demand, for `tests/browser/next-boundary.spec.ts`. Each pane has
 * a boundary of its own before this one, and `next-side.spec.ts` proves those
 * in the real list window; this is what's left when the window's own frame
 * can't be drawn.
 *
 * Open it at /tests/fixtures/next-boundary.html. `window.boundary.breakIt()`
 * makes the part throw the next time it draws, as any drawing bug would. A
 * reload starts the page over, and it draws again.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WindowBoundary } from "../../src/next/app/Boundary";
import "../../src/next/styles/app.css";

declare global {
  interface Window {
    boundary?: { breakIt: () => void };
  }
}

function Breakable() {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    window.boundary = { breakIt: () => setBroken(true) };
  }, []);
  if (broken) throw new Error("A drawing bug, on purpose (tests/fixtures/next-boundary.tsx).");
  return <p>Drawing fine.</p>;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <WindowBoundary>
      <Breakable />
    </WindowBoundary>
  </StrictMode>,
);
