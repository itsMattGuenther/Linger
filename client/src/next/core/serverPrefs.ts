/**
 * Your servers' order and which are Quiet (docs/design/buddy-list.md, "Several
 * servers"): choices about this computer, kept on it. The order is yours and
 * never reshuffles by activity; a server you sign in to later joins at the
 * bottom.
 */

export interface ServerPrefs {
  /** Server addresses, in your order. */
  order: string[];
  /** Servers set to Quiet: no chimes, no bold, no arrival cards. Knocks still get through. */
  quiet: string[];
}

/** The part of `Storage` this needs, so tests can hand it a plain one. */
export interface PrefsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "linger.next.servers";
const NONE: ServerPrefs = { order: [], quiet: [] };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Prefs from anything: what's kept on this computer, or what another window sent. Anything else is none. */
export function prefsFrom(value: unknown): ServerPrefs {
  if (typeof value !== "object" || value === null) return NONE;
  return { order: strings("order" in value ? value.order : []), quiet: strings("quiet" in value ? value.quiet : []) };
}

export function loadServerPrefs(store: PrefsStore | null): ServerPrefs {
  try {
    return prefsFrom(JSON.parse(store?.getItem(KEY) ?? "null"));
  } catch {
    return NONE;
  }
}

export function saveServerPrefs(store: PrefsStore | null, prefs: ServerPrefs): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage refused: the order holds until the app closes.
  }
}

/** Your servers in your order: the ones you've placed first, then any new ones as they came. */
export function inOrder<T extends { baseUrl: string }>(servers: readonly T[], order: readonly string[]): T[] {
  const place = (server: T) => {
    const at = order.indexOf(server.baseUrl);
    return at === -1 ? order.length + servers.indexOf(server) : at;
  };
  return [...servers].sort((a, b) => place(a) - place(b));
}
