import { useCallback } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import { ApiError, TransportError } from "../../../lib/api";
import type { Following } from "../../core/mirror";
import { type SearchAsk, SearchView } from "../search/SearchView";
import { useViewServers } from "../useViewServers";
import { ToolWindow } from "./ToolWindow";

/** Search in a window of its own (decision 15), opened from the list's foot. */
export function SearchWindow() {
  return (
    <ToolWindow title="Search" icon="search" screen="search-window">
      {(following, shown) => <Search following={following} shown={shown} />}
    </ToolWindow>
  );
}

function Search({ following, shown }: { following: Following; shown: number }) {
  const { apis, intend } = following;
  const servers = useViewServers(apis);
  const search = useCallback(
    async (server: string, ask: SearchAsk) => {
      const api = apis.get(server);
      if (!api) return "You're not signed in to that server any more.";
      try {
        return await api.search({ q: ask.q, room: ask.room, author: ask.author, before: ask.before, limit: ask.limit });
      } catch (error: unknown) {
        return error instanceof ApiError || error instanceof TransportError ? error.message : "Couldn't reach the server.";
      }
    },
    [apis],
  );
  // A hit opens its conversation at that message, where conversations open (CONV-17).
  const onOpenHit = useCallback(
    (server: string, roomId: RoomId, messageId: MessageId) => {
      const room = servers.find((one) => one.server === server)?.rooms.find((one) => one.id === roomId);
      void intend({ kind: "open", server, roomId, conversation: room?.kind === "dm" ? "dm" : "room", messageId }).catch(() => undefined);
    },
    [servers, intend],
  );
  return <SearchView servers={servers} search={search} onOpenHit={onOpenHit} focusRequest={shown} />;
}
