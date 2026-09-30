/**
 * Where the list is drawn, across the window: all of it on its own, or its
 * column beside the conversations (#337). What the list opens over itself (a
 * person's card, the away editor, the new DM picker) is centred on this, not
 * on the window, so it never lands over a conversation.
 */
export function listSpan(): { left: number; width: number } {
  const box = document.querySelector(".nx-list")?.getBoundingClientRect();
  return box && box.width > 0 ? { left: box.left, width: box.width } : { left: 0, width: window.innerWidth };
}

/** The left edge that centres something this wide on the list, kept `edge` inside the window. */
export function centredOnList(width: number, edge: number): number {
  const span = listSpan();
  return Math.max(edge, Math.min(Math.round(span.left + (span.width - width) / 2), window.innerWidth - width - edge));
}
