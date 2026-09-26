import { useCallback } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import { ApiError, TransportError } from "../../../lib/api";
import { openExternal, openExternalChecked } from "../../../lib/external";
import { absoluteUrl } from "../../../lib/url";
import type { Following } from "../../core/mirror";
import { type MediaAsk, MediaView } from "../media/MediaView";
import { useViewServers } from "../useViewServers";
import { ToolWindow } from "./ToolWindow";

/** The media collection in a window of its own (decision 15), opened from the list's foot. */
export function MediaWindow() {
  return (
    <ToolWindow title="Media" icon="media" screen="media-window">
      {(following) => <Media following={following} />}
    </ToolWindow>
  );
}

/** A refusal or an outage, in words. */
function inWords(error: unknown): string {
  return error instanceof ApiError || error instanceof TransportError ? error.message : "Couldn't reach the server.";
}

function Media({ following }: { following: Following }) {
  const { apis, intend } = following;
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
      void intend({ kind: "open", server, roomId, conversation: room?.kind === "dm" ? "dm" : "room", messageId }).catch(() => undefined);
    },
    [servers, intend],
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
