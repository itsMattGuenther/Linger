/**
 * The chat window's tabs (docs/design/buddy-list.md, "Conversations: tabs or
 * windows"): which conversations are open, in what order, and which one is
 * showing. Pure, so every move is tested without a window.
 *
 * A tab is a conversation on a server. Opening one that is already open
 * shows it rather than adding a second. Closing the showing tab shows its
 * right-hand neighbor, or the left one at the end, the way browsers do.
 */
import type { RoomId } from "../../generated/RoomId";

export interface TabKey {
  server: string;
  roomId: RoomId;
}

export interface Tabs {
  open: TabKey[];
  /** Always one of `open`, or null when none is. */
  active: TabKey | null;
}

export const NO_TABS: Tabs = { open: [], active: null };

export function same(a: TabKey | null, b: TabKey | null): boolean {
  return a !== null && b !== null && a.server === b.server && a.roomId === b.roomId;
}

/** A stable string for a tab, for React keys and storage. */
export function keyOf(tab: TabKey): string {
  return `${tab.server}#${tab.roomId}`;
}

/** Show a conversation: its tab if open, a new one at the end if not. */
export function openTab(tabs: Tabs, tab: TabKey): Tabs {
  const existing = tabs.open.find((held) => same(held, tab));
  if (existing) return { ...tabs, active: existing };
  const added = { server: tab.server, roomId: tab.roomId };
  return { open: [...tabs.open, added], active: added };
}

export function selectTab(tabs: Tabs, tab: TabKey): Tabs {
  const existing = tabs.open.find((held) => same(held, tab));
  return existing ? { ...tabs, active: existing } : tabs;
}

export function closeTab(tabs: Tabs, tab: TabKey): Tabs {
  const index = tabs.open.findIndex((held) => same(held, tab));
  if (index === -1) return tabs;
  const open = tabs.open.filter((_, at) => at !== index);
  if (!same(tabs.active, tab)) return { open, active: tabs.active };
  const next = open[index] ?? open[index - 1] ?? null;
  return { open, active: next };
}

/** Move a tab to a new position (dragging along the row), keeping it showing if it was. */
export function moveTab(tabs: Tabs, tab: TabKey, to: number): Tabs {
  const from = tabs.open.findIndex((held) => same(held, tab));
  if (from === -1) return tabs;
  const open = [...tabs.open];
  const [moved] = open.splice(from, 1);
  if (!moved) return tabs;
  open.splice(Math.max(0, Math.min(to, open.length)), 0, moved);
  return { open, active: tabs.active };
}

/** The tab `step` places along from the showing one, wrapping (Alt+←/→ in the prototype, Ctrl+Tab in the app). */
export function stepTab(tabs: Tabs, step: number): Tabs {
  if (tabs.open.length === 0 || tabs.active === null) return tabs;
  const index = tabs.open.findIndex((held) => same(held, tabs.active));
  const length = tabs.open.length;
  const next = tabs.open[(((index + step) % length) + length) % length];
  return next ? { ...tabs, active: next } : tabs;
}

/** Drop tabs for conversations that no longer exist or that this window can't see. */
export function keepOnly(tabs: Tabs, exists: (tab: TabKey) => boolean): Tabs {
  const open = tabs.open.filter(exists);
  if (open.length === tabs.open.length) return tabs;
  const active = tabs.active !== null && open.some((held) => same(held, tabs.active)) ? tabs.active : (open[0] ?? null);
  return { open, active };
}

/**
 * Tabs as stored on this computer, so they come back after a restart. Read
 * back defensively: anything malformed is dropped rather than trusted.
 */
export function saveTabs(tabs: Tabs): string {
  return JSON.stringify({ v: 1, open: tabs.open, active: tabs.active });
}

export function loadTabs(stored: string | null): Tabs {
  if (stored === null) return NO_TABS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return NO_TABS;
  }
  if (typeof parsed !== "object" || parsed === null || !("v" in parsed) || parsed.v !== 1 || !("open" in parsed) || !Array.isArray(parsed.open)) {
    return NO_TABS;
  }
  const open = parsed.open.filter(isTabKey).map((tab) => ({ server: tab.server, roomId: tab.roomId }));
  const wanted = "active" in parsed && isTabKey(parsed.active) ? parsed.active : null;
  const active = open.find((held) => same(held, wanted)) ?? open[0] ?? null;
  return { open, active };
}

function isTabKey(value: unknown): value is TabKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "server" in value &&
    "roomId" in value &&
    typeof value.server === "string" &&
    typeof value.roomId === "string" &&
    value.server.length > 0 &&
    value.roomId.length > 0
  );
}
