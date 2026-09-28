/**
 * The one-line cards links render as (SPEC §5.6).
 *
 * A card holds a favicon, a title and a domain, and every one of those comes
 * from the server — **the client never fetches a preview and never points an
 * `<img>` at a linked site**. If it did, scrolling past a message would tell
 * that site who read it, which is exactly the thing this product is for not
 * doing. The favicon arrives inline as a `data:` URI, so drawing a card makes
 * no request at all (PROTOCOL §6).
 *
 * What lives here is the asking: a small per-server cache, and one round trip
 * for however many links came on screen together rather than one each. Rows
 * mount and unmount constantly in a virtualized list, so a URL is asked about
 * once and remembered, including when the answer was "nothing" — a card with
 * just its domain is a finished card, not a retry.
 */
import { useSyncExternalStore } from "react";

import type { LinkPreview } from "../generated/LinkPreview";
import type { AuthedApi } from "./api";

/** The server's own cap on one call (`MAX_LINK_PREVIEW_BATCH`). */
const BATCH = 16;

/** Long enough to gather a screen's worth, short enough not to be a wait. */
const GATHER_MS = 60;

type ServerCache = Record<string, LinkPreview>;

let cards: Record<string, ServerCache> = {};
const asked = new Map<string, Set<string>>();
const queued = new Map<string, Set<string>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const EMPTY: ServerCache = {};

function announce(): void {
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

function cacheOf(server: string): ServerCache {
  return cards[server] ?? EMPTY;
}

function setOf(held: Map<string, Set<string>>, server: string): Set<string> {
  const found = held.get(server);
  if (found) return found;
  const fresh = new Set<string>();
  held.set(server, fresh);
  return fresh;
}

/**
 * Ask about some links. Anything already asked about is skipped, so calling
 * this on every render of a message row costs nothing after the first.
 */
export function wantPreviews(api: AuthedApi, urls: string[]): void {
  const server = api.baseUrl;
  const seen = setOf(asked, server);
  const waiting = setOf(queued, server);
  let added = false;
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    waiting.add(url);
    added = true;
  }
  if (!added || timers.has(server)) return;

  timers.set(
    server,
    setTimeout(() => {
      timers.delete(server);
      void drain(api);
    }, GATHER_MS),
  );
}

async function drain(api: AuthedApi): Promise<void> {
  const server = api.baseUrl;
  const waiting = setOf(queued, server);
  const batch = [...waiting].slice(0, BATCH);
  for (const url of batch) waiting.delete(url);
  if (batch.length === 0) return;

  try {
    const answers = await api.linkPreviews(batch);
    const next: ServerCache = { ...cacheOf(server) };
    for (const card of answers) next[card.url] = card;
    cards = { ...cards, [server]: next };
    announce();
  } catch {
    // A card that didn't arrive isn't worth a message: the link is still a
    // link, and it renders as one. Let it be asked about again next time.
    for (const url of batch) setOf(asked, server).delete(url);
  }

  // Whatever a screenful over the batch cap left behind.
  if (waiting.size > 0) void drain(api);
}

/** Everything known about this server's links. */
export function useLinkPreviews(server: string): ServerCache {
  return useSyncExternalStore(subscribe, () => cacheOf(server));
}

/** Drop a server's cards when its sign-in goes. Cards are cheap, but they are
 *  that server's, and a re-added server should ask again. */
export function forgetPreviews(server: string): void {
  asked.delete(server);
  queued.delete(server);
  const timer = timers.get(server);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(server);
  }
  if (!(server in cards)) return;
  const next = { ...cards };
  delete next[server];
  cards = next;
  announce();
}
