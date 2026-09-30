import { useCallback } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import { ApiError, type AuthedApi, TransportError } from "../../../lib/api";
import { openExternal, openExternalChecked } from "../../../lib/external";
import { absoluteUrl } from "../../../lib/url";
import { type MediaAsk, MediaView } from "../media/MediaView";
import { type SearchAsk, SearchView } from "../search/SearchView";
import { useViewServers } from "../useViewServers";

/** Show a conversation at a message, wherever the host shows them; it says which kind, for a DM the owner may not have heard of yet. */
export type OpenFound = (server: string, roomId: RoomId, messageId: MessageId, conversation: "room" | "dm") => void;

/** A refusal or an outage, in words. */
function inWords(error: unknown): string {
  return error instanceof ApiError || error instanceof TransportError ? error.message : "Couldn't reach the server.";
}

/**
 * The media collection (decision 15) with its wiring, for whatever holds it:
 * a tab beside the list (#337), or a window of its own. It asks each server
 * itself, with the sign-in it's given.
 */
export function MediaPanel({ apis, onOpen }: { apis: ReadonlyMap<string, AuthedApi>; onOpen: OpenFound }) {
  const servers = useViewServers(apis);
  const media = useCallback(
    async (server: string, ask: MediaAsk) => {
      const api = apis.get(server);
      if (!api) return "You're not signed in to that server any more.";
      try {
        return await api.media({ kind: ask.kind, author: ask.author, since: ask.since, until: ask.until, before: ask.before, limit: ask.limit });
      } catch (error: unknown) {
        return inWords(error);
      }
    },
    [apis],
  );
  const star = useCallback(
    async (server: string, attachmentId: string, starred: boolean) => {
      const api = apis.get(server);
      if (!api) return "You're not signed in to that server any more.";
      try {
        await (starred ? api.starMedia(attachmentId) : api.unstarMedia(attachmentId));
        return null;
      } catch (error: unknown) {
        return inWords(error);
      }
    },
    [apis],
  );
  const mediaUrl = useCallback((server: string, path: string) => absoluteUrl(apis.get(server)?.baseUrl ?? server, path), [apis]);
  // A tile opens its message, where conversations open (MEDIA-4, CONV-17).
  const onOpenItem = useCallback(
    (server: string, roomId: RoomId, messageId: MessageId) => {
      const room = servers.find((one) => one.server === server)?.rooms.find((one) => one.id === roomId);
      onOpen(server, roomId, messageId, room?.kind === "dm" ? "dm" : "room");
    },
    [servers, onOpen],
  );
  const onDownload = useCallback(
    (server: string, file: Attachment) => void openExternalChecked(mediaUrl(server, file.url)).catch(() => undefined),
    [mediaUrl],
  );
  return (
    <MediaView
      servers={servers}
      media={media}
      star={star}
      mediaUrl={mediaUrl}
      onOpenItem={onOpenItem}
      onOpenLink={openExternal}
      onDownload={onDownload}
    />
  );
}

/**
 * Search (decision 15) with its wiring, for whatever holds it: a tab beside
 * the list (#337), or a window of its own. `focusRequest` changes when the
 * cursor should go back in the box (Ctrl+K again).
 */
export function SearchPanel({ apis, onOpen, focusRequest }: { apis: ReadonlyMap<string, AuthedApi>; onOpen: OpenFound; focusRequest: number }) {
  const servers = useViewServers(apis);
  const search = useCallback(
    async (server: string, ask: SearchAsk) => {
      const api = apis.get(server);
      if (!api) return "You're not signed in to that server any more.";
      try {
        return await api.search({ q: ask.q, room: ask.room, author: ask.author, before: ask.before, limit: ask.limit });
      } catch (error: unknown) {
        return inWords(error);
      }
    },
    [apis],
  );
  // A hit opens its conversation at that message, where conversations open (CONV-17).
  const onOpenHit = useCallback(
    (server: string, roomId: RoomId, messageId: MessageId) => {
      const room = servers.find((one) => one.server === server)?.rooms.find((one) => one.id === roomId);
      onOpen(server, roomId, messageId, room?.kind === "dm" ? "dm" : "room");
    },
    [servers, onOpen],
  );
  return <SearchView servers={servers} search={search} onOpenHit={onOpenHit} focusRequest={focusRequest} />;
}
