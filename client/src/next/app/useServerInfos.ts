import { useEffect, useState } from "react";
import type { AuthedApi } from "../../lib/api";

/** What a window says about a server: its name, and the host's color (a palette key). */
export interface ServerTagInfo {
  name: string;
  accent: string | null;
  /** How many days it keeps a file, or null for good (the media view says so). */
  fileExpiryDays?: number | null;
  /** How much its files take up, and how much it allows, in bytes. */
  storage?: { used: number; limit: number };
}

/**
 * Each server's name and color, asked of each server once, with this
 * window's sign-in (borrowed, in a viewer). Until a server answers, it goes
 * by its address.
 */
export function useServerInfos(apis: ReadonlyMap<string, AuthedApi>): Readonly<Record<string, ServerTagInfo>> {
  const [infos, setInfos] = useState<Readonly<Record<string, ServerTagInfo>>>({});
  // A window's servers change in place (signed in to, or out of, while it's
  // open), so which ones it has is read afresh on every draw.
  const which = [...apis.keys()].join(" ");
  useEffect(() => {
    const abort = new AbortController();
    for (const [server, api] of apis) {
      void api
        .serverInfo(abort.signal)
        .then((info) =>
          setInfos((held) => ({ ...held, [server]: {
            name: info.name,
            accent: info.accent_key ?? null,
            fileExpiryDays: info.file_expiry_days,
            storage: { used: info.storage_used_bytes, limit: info.storage_limit_bytes },
          } })),
        )
        .catch(() => undefined);
    }
    return () => abort.abort();
  }, [apis, which]);
  return infos;
}

/** A server's name while it hasn't said: its address, without the scheme. */
export function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
