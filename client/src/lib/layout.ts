/** Responsive panels follow the space available at the reader's chosen scale. */
import { useSyncExternalStore } from "react";

function subscribeWidth(changed: () => void): () => void {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
}

export function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeWidth,
    () => window.innerWidth,
    () => 1100,
  );
}

export function useWindowHeight(): number {
  return useSyncExternalStore(
    subscribeWidth,
    () => window.innerHeight,
    () => 720,
  );
}

/** Fit saved panels without overwriting their preferred widths on small windows. */
export function frameLayout(
  width: number,
  scale: number,
  rail: number,
  roster: number,
) {
  const available = width / (scale / 100);
  const stacked = available < 640;
  const narrow = available < 960;
  const room = Math.max(0, available - 420 - 8);
  const extra = Math.max(0, rail + roster - room);
  const fittedRail = Math.max(200, rail - extra / 2);
  const fittedRoster = Math.max(232, Math.min(roster, room - fittedRail));
  return {
    stacked,
    narrow,
    rail: narrow
      ? Math.min(rail, Math.max(200, available - 420 - 4))
      : Math.min(fittedRail, room - fittedRoster),
    roster: fittedRoster,
  };
}
