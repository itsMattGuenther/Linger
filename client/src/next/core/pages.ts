/**
 * Paging through several servers at once, for search and media with every
 * server picked. Pure; the views hold the pages and draw what this says.
 *
 * Each server pages on its own (keyset cursors, PROTOCOL §6), and one
 * server's cursor means nothing to another, so their lists are merged here in
 * the order each server already sorts by: newest first for search, starred
 * first and then newest for media.
 *
 * The one subtle part is where a merged list may stop. A server that has more
 * to give has only sent the start of its list, and everything it hasn't sent
 * sorts after the last thing it did. So an item from another server that sorts
 * after that last item can't be shown yet: something the first server hasn't
 * sent might belong ahead of it. Those items wait until that server's next
 * page arrives. With one server this is ordinary paging.
 */

/** One server's list, as far as it has been read. */
export interface Stream<T> {
  /** What the server has sent so far, in its own order. */
  items: readonly T[];
  /**
   * Whether it may have more. A server that hasn't answered yet has more and
   * no items, and holds everything back: nothing is known about its order.
   */
  more: boolean;
}

export interface Merged<T> {
  /** What can be shown, in order, each with the server it came from. */
  shown: { server: string; item: T }[];
  /** The servers to ask for their next page when the reader wants older things. */
  next: string[];
  /** Whether asking for older can bring anything. */
  more: boolean;
}

/**
 * Merge several servers' lists into one.
 *
 * `order` is the servers' own sort: negative when `a` comes before `b`. Ties
 * keep the order the streams were given in, so the list never shuffles
 * between two draws of the same pages.
 */
export function merge<T>(streams: readonly (readonly [string, Stream<T>])[], order: (a: T, b: T) => number): Merged<T> {
  const all = streams.flatMap(([server, stream]) => stream.items.map((item) => ({ server, item })));
  all.sort((a, b) => order(a.item, b.item));

  // The earliest-sorting last item of any server that has more: nothing past
  // it can be shown yet.
  let bound: T | null = null;
  for (const [, stream] of streams) {
    if (!stream.more) continue;
    const last = stream.items.at(-1);
    if (last === undefined) return { shown: [], next: [], more: true };
    if (bound === null || order(last, bound) < 0) bound = last;
  }
  const edge = bound;
  const shown = edge === null ? all : all.filter(({ item }) => order(item, edge) <= 0);

  // Ask the servers holding the edge: their last item is on screen, so the
  // next thing to show might be theirs. A server whose items are already
  // waiting has sent enough for now.
  const onScreen = new Set(shown.map(({ item }) => item));
  const next = streams
    .filter(([, stream]) => {
      const last = stream.items.at(-1);
      return stream.more && last !== undefined && onScreen.has(last);
    })
    .map(([server]) => server);
  return { shown, next, more: streams.some(([, stream]) => stream.more) };
}
