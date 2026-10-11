/**
 * Every time React commits a window's drawing, counted in `window.commits`,
 * so a spec can say an idle window draws nothing at all (#511). React's
 * Profiler reports each commit in development, which is what the page
 * server serves.
 */
import { Profiler, type ReactNode } from "react";

declare global {
  interface Window {
    /** How many times React has committed this window's drawing. */
    commits?: number;
  }
}

function counted(): void {
  window.commits = (window.commits ?? 0) + 1;
}

export function Counted({ children }: { children: ReactNode }) {
  return (
    <Profiler id="window" onRender={counted}>
      {children}
    </Profiler>
  );
}
