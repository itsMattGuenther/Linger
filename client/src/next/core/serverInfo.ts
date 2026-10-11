/**
 * Each server's name and color in the list (#536): asked when its connection
 * comes up or comes back, then once an hour while it stays up, and kept only
 * when they differ from what the list already shows.
 *
 * They used to be asked every two minutes: 720 times a day per server, each
 * one adding up every file the server holds, needing a fresh sign-in token,
 * and drawing the whole list again with the same name. A push from the
 * server when its name or color changes would end the asking; that is a
 * protocol addition, and not made here.
 *
 * Pure apart from its timer, so it's tested with a fake clock.
 */
import type { ServerInfo } from "../../generated/ServerInfo";

/**
 * How often a server is asked again while its connection stays up. Its name
 * and color change about once ever, and they're asked for every time the
 * connection comes up or comes back (waking the computer, another network,
 * the server restarting), so this only catches a host changing them while
 * you stay connected. An hour is 24 asks a day instead of 720, and at most
 * one token renewal an hour from it (#520). The host's own change shows at
 * once: Settings tells the list (the `serverinfo` intent, core/share.ts).
 */
export const INFO_EVERY_MS = 60 * 60_000;

/**
 * How soon an ask that failed is tried again: the old cadence, so a server
 * that was busy for a moment isn't shown by its address for an hour.
 */
export const INFO_RETRY_MS = 2 * 60_000;

/** What the list shows of a server: its name and the host's color (a palette key). */
export type ListedInfo = Pick<ServerInfo, "name" | "accent_key">;

/**
 * The list's held answers with one server's new one. The very same object
 * when nothing the list shows has changed, so React keeps what it drew
 * rather than drawing the whole list again.
 */
export function withInfo(
  held: Readonly<Record<string, ListedInfo>>,
  server: string,
  info: ListedInfo,
): Readonly<Record<string, ListedInfo>> {
  const was = held[server];
  if (was !== undefined && was.name === info.name && was.accent_key === info.accent_key) return held;
  return { ...held, [server]: { name: info.name, accent_key: info.accent_key } };
}

/**
 * Ask now, then `every` after each answer, or `retry` after a failure,
 * until stopped. Stopping also drops an answer still on its way. Answers how
 * to stop.
 */
export function keepAsking(ask: (signal: AbortSignal) => Promise<unknown>, every = INFO_EVERY_MS, retry = INFO_RETRY_MS): () => void {
  const abort = new AbortController();
  let next: ReturnType<typeof setTimeout> | undefined;
  const go = () => {
    void ask(abort.signal)
      .then(
        () => every,
        () => retry,
      )
      .then((wait) => {
        if (!abort.signal.aborted) next = setTimeout(go, wait);
      });
  };
  go();
  return () => {
    abort.abort();
    clearTimeout(next);
  };
}
