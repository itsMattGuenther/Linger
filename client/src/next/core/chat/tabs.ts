/**
 * The chat window's tabs as data (docs/design/buddy-list.md, "Conversations:
 * tabs or windows"). Pure, so opening, closing and reordering are tested
 * without a window.
 */

export interface TabsState {
  /** Conversation ids, left to right. */
  order: readonly string[];
  /** The showing tab, or null when none is open. */
  active: string | null;
}

export const NO_TABS: TabsState = { order: [], active: null };

/**
 * Open a conversation: show its tab, adding it at the end if it isn't open.
 * `background` adds it without showing it (a DM that arrives while you read).
 */
export function openTab(state: TabsState, id: string, background = false): TabsState {
  const order = state.order.includes(id) ? state.order : [...state.order, id];
  const active = background && state.active !== null ? state.active : id;
  return order === state.order && active === state.active ? state : { order, active };
}

export function selectTab(state: TabsState, id: string): TabsState {
  if (!state.order.includes(id) || state.active === id) return state;
  return { ...state, active: id };
}

/**
 * Close a tab. Closing the showing one shows its right-hand neighbor, or the
 * left-hand one at the end of the row, the way browsers do.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const at = state.order.indexOf(id);
  if (at < 0) return state;
  const order = state.order.filter((one) => one !== id);
  if (state.active !== id) return { order, active: state.active };
  const active = order[at] ?? order[at - 1] ?? null;
  return { order, active };
}

/** Move a tab to a new place in the row (dragging). */
export function moveTab(state: TabsState, id: string, to: number): TabsState {
  const at = state.order.indexOf(id);
  if (at < 0) return state;
  const order = state.order.filter((one) => one !== id);
  const place = Math.max(0, Math.min(to, order.length));
  order.splice(place, 0, id);
  return order.every((one, index) => one === state.order[index]) ? state : { ...state, order };
}

/** The tab after (or before) the showing one, wrapping: Ctrl+Tab. */
export function stepTab(state: TabsState, by: 1 | -1): TabsState {
  if (state.active === null || state.order.length < 2) return state;
  const at = state.order.indexOf(state.active);
  const next = state.order[(at + by + state.order.length) % state.order.length];
  return next === undefined ? state : { ...state, active: next };
}
