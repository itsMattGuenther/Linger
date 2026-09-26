import { useMemo } from "react";
import type { AuthedApi } from "../../lib/api";
import { useServers } from "../../lib/gateway";
import type { MediaServer } from "./media/MediaView";
import { inOrder, loadServerPrefs } from "../core/serverPrefs";
import { hostOf, useServerInfos } from "./useServerInfos";

/**
 * The servers a Search or Media window looks through, as those views want
 * them (core/scope.ts): in your order, each with its name and color, who you
 * are there, its people, and its rooms together with your DMs.
 */
export function useViewServers(apis: ReadonlyMap<string, AuthedApi>): MediaServer[] {
  const states = useServers();
  const infos = useServerInfos(apis);
  const which = [...apis.keys()].join(" ");
  return useMemo(() => {
    let order: string[] = [];
    try {
      order = loadServerPrefs(window.localStorage).order;
    } catch {
      // Storage refused: the order they were signed in to.
    }
    return inOrder(
      which === "" ? [] : which.split(" ").map((baseUrl) => ({ baseUrl })),
      order,
    ).flatMap(({ baseUrl }): MediaServer[] => {
      const state = states[baseUrl];
      if (!state) return [];
      const info = infos[baseUrl];
      return [
        {
          server: baseUrl,
          name: info?.name ?? hostOf(baseUrl),
          accent: info?.accent ?? null,
          me: state.me?.id ?? null,
          users: state.users,
          rooms: [...state.rooms, ...state.dms],
          expiryDays: info?.fileExpiryDays,
          storage: info?.storage,
        },
      ];
    });
  }, [states, infos, which]);
}
