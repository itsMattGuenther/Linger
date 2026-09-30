/**
 * The tabs beside the list (docs/design/buddy-list.md, "Conversations beside
 * the list"): which are open, in what order, and which one is showing. Pure,
 * so every move is tested without a window.
 *
 * A tab is a conversation on a server, or Media or Search (#337). Opening one
 * that is already open shows it rather than adding a second. Closing the
 * showing tab shows its right-hand neighbor, or the left one at the end, the
 * way browsers do.
 */
import type { RoomId } from "../../generated/RoomId";

/** A conversation's tab: a room or DM on a server. */
export interface TabKey {
  server: string;
  roomId: RoomId;
}

/** Media or Search, as a tab beside the list (#337): one of each, across every server. */
export interface ToolTab {
  tool: "media" | "search";
}

/** Anything the tabs beside the list can hold. */
export type SideTab = TabKey | ToolTab;

export function isTool(tab: SideTab): tab is ToolTab {
  return "tool" in tab;
}

export interface Tabs<T extends SideTab = TabKey> {
  open: T[];
  /** Always one of `open`, or null when none is. */
  active: T | null;
}

export const NO_TABS: Tabs<never> = { open: [], active: null };

export function same(a: SideTab | null, b: SideTab | null): boolean {
  if (a === null || b === null) return false;
  if (isTool(a) || isTool(b)) return isTool(a) && isTool(b) && a.tool === b.tool;
  return a.server === b.server && a.roomId === b.roomId;
}

/** A stable string for a tab, for React keys and storage. */
export function keyOf(tab: SideTab): string {
  return isTool(tab) ? `tool:${tab.tool}` : `${tab.server}#${tab.roomId}`;
}

/** Show a tab: its own if open, a new one at the end if not. */
export function openTab<T extends SideTab>(tabs: Tabs<T>, tab: T): Tabs<T> {
  const existing = tabs.open.find((held) => same(held, tab));
  if (existing) return { ...tabs, active: existing };
  return { open: [...tabs.open, tab], active: tab };
}

export function selectTab<T extends SideTab>(tabs: Tabs<T>, tab: T): Tabs<T> {
  const existing = tabs.open.find((held) => same(held, tab));
  return existing ? { ...tabs, active: existing } : tabs;
}

export function closeTab<T extends SideTab>(tabs: Tabs<T>, tab: T): Tabs<T> {
  const index = tabs.open.findIndex((held) => same(held, tab));
  if (index === -1) return tabs;
  const open = tabs.open.filter((_, at) => at !== index);
  if (!same(tabs.active, tab)) return { open, active: tabs.active };
  const next = open[index] ?? open[index - 1] ?? null;
  return { open, active: next };
}

/** Move a tab to a new position (dragging along the row), keeping it showing if it was. */
export function moveTab<T extends SideTab>(tabs: Tabs<T>, tab: T, to: number): Tabs<T> {
  const from = tabs.open.findIndex((held) => same(held, tab));
  if (from === -1) return tabs;
  const open = [...tabs.open];
  const [moved] = open.splice(from, 1);
  if (!moved) return tabs;
  open.splice(Math.max(0, Math.min(to, open.length)), 0, moved);
  return { open, active: tabs.active };
}

/** The tab `step` places along from the showing one, wrapping (Alt+←/→ in the prototype, Ctrl+Tab in the app). */
export function stepTab<T extends SideTab>(tabs: Tabs<T>, step: number): Tabs<T> {
  if (tabs.open.length === 0 || tabs.active === null) return tabs;
  const index = tabs.open.findIndex((held) => same(held, tabs.active));
  const length = tabs.open.length;
  const next = tabs.open[(((index + step) % length) + length) % length];
  return next ? { ...tabs, active: next } : tabs;
}

/** Drop tabs for conversations that no longer exist or that this window can't see. */
export function keepOnly<T extends SideTab>(tabs: Tabs<T>, exists: (tab: T) => boolean): Tabs<T> {
  const open = tabs.open.filter(exists);
  if (open.length === tabs.open.length) return tabs;
  const active = tabs.active !== null && open.some((held) => same(held, tabs.active)) ? tabs.active : (open[0] ?? null);
  return { open, active };
}

/**
 * Tabs as stored on this computer, so they come back after a restart. Read
 * back defensively: anything malformed is dropped rather than trusted.
 */
export function saveTabs(tabs: Tabs<SideTab>): string {
  return JSON.stringify({ v: 1, open: tabs.open, active: tabs.active });
}

export function loadTabs(stored: string | null): Tabs<SideTab> {
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
  const open = parsed.open.flatMap((tab: unknown): SideTab[] => {
    if (isTabKey(tab)) return [{ server: tab.server, roomId: tab.roomId }];
    if (isToolTab(tab)) return [{ tool: tab.tool }];
    return [];
  });
  const wanted = "active" in parsed && (isTabKey(parsed.active) || isToolTab(parsed.active)) ? parsed.active : null;
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

function isToolTab(value: unknown): value is ToolTab {
  return typeof value === "object" && value !== null && "tool" in value && (value.tool === "media" || value.tool === "search");
}
