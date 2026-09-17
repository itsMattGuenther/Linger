/** Private display preferences. They never leave this computer. */
import { useSyncExternalStore } from "react";

export const SCALE_OPTIONS = [100, 110, 125, 150, 175, 200] as const;
const SCALE_KEY = "linger.interface.scale";
const changed = new Set<() => void>();

export function validScale(value: unknown): number {
  return typeof value === "number" &&
    SCALE_OPTIONS.some((option) => option === value)
    ? value
    : 100;
}

function readScale(): number {
  if (typeof window === "undefined") return 100;
  try {
    return validScale(Number(localStorage.getItem(SCALE_KEY)));
  } catch {
    return 100;
  }
}
let scale = readScale();

/** Apply before first paint, including the sign-in screens. */
export function applyInterfaceScale(): void {
  document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
}

export function setInterfaceScale(next: number): void {
  scale = validScale(next);
  try {
    localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    /* Session-only works too. */
  }
  applyInterfaceScale();
  for (const listener of changed) listener();
}

function subscribe(listener: () => void): () => void {
  changed.add(listener);
  return () => {
    changed.delete(listener);
  };
}

export function useInterfaceScale(): number {
  return useSyncExternalStore(
    subscribe,
    () => scale,
    () => 100,
  );
}

export type PanelSide = "rail" | "roster";
export const PANEL_LIMITS = {
  rail: { min: 200, max: 360, initial: 232 },
  roster: { min: 232, max: 400, initial: 264 },
};

export function clampPanel(side: PanelSide, value: number): number {
  const limits = PANEL_LIMITS[side];
  return Number.isFinite(value)
    ? Math.round(Math.min(limits.max, Math.max(limits.min, value)))
    : limits.initial;
}

export function loadPanel(side: PanelSide): number {
  try {
    const value = localStorage.getItem(`linger.interface.${side}`);
    return value === null
      ? PANEL_LIMITS[side].initial
      : clampPanel(side, Number(value));
  } catch {
    return PANEL_LIMITS[side].initial;
  }
}

export function savePanel(side: PanelSide, width: number): void {
  try {
    localStorage.setItem(
      `linger.interface.${side}`,
      String(clampPanel(side, width)),
    );
  } catch {
    /* A blocked preference must not prevent resizing. */
  }
}
