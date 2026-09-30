import { useCallback } from "react";
import type { Following } from "../../core/mirror";
import { type OpenFound, SearchPanel } from "./panels";
import { ToolWindow } from "./ToolWindow";

/**
 * Search in a window of its own (decision 15): popped out of the tabs beside
 * the list, or opened here because conversations open each in its own
 * window (#337).
 */
export function SearchWindow() {
  return (
    <ToolWindow title="Search" icon="search" screen="search-window" which="search">
      {(following, shown) => <Search following={following} shown={shown} />}
    </ToolWindow>
  );
}

function Search({ following, shown }: { following: Following; shown: number }) {
  const { apis, intend } = following;
  const onOpen = useCallback<OpenFound>(
    (server, roomId, messageId, conversation) => void intend({ kind: "open", server, roomId, conversation, messageId }).catch(() => undefined),
    [intend],
  );
  return <SearchPanel apis={apis} onOpen={onOpen} focusRequest={shown} />;
}
