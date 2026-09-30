import { useCallback } from "react";
import type { Following } from "../../core/mirror";
import { type OpenFound, MediaPanel } from "./panels";
import { ToolWindow } from "./ToolWindow";

/**
 * The media collection in a window of its own (decision 15): popped out of
 * the tabs beside the list, or opened here because conversations open each
 * in its own window (#337).
 */
export function MediaWindow() {
  return (
    <ToolWindow title="Media" icon="media" screen="media-window" which="media">
      {(following) => <Media following={following} />}
    </ToolWindow>
  );
}

function Media({ following }: { following: Following }) {
  const { apis, intend } = following;
  const onOpen = useCallback<OpenFound>(
    (server, roomId, messageId, conversation) => void intend({ kind: "open", server, roomId, conversation, messageId }).catch(() => undefined),
    [intend],
  );
  return <MediaPanel apis={apis} onOpen={onOpen} />;
}
