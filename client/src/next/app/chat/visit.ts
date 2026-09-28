import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { AuthedApi } from "../../../lib/api";
import { enterRoom, type GatewayState, leaveWindow, onStateChange, openAround, openRoom, releaseOtherRooms, serverState } from "../../../lib/gateway";
import { openingAt } from "../../core/chat/conversation";
import type { Following } from "../../core/mirror";
import { keyOf, type TabKey } from "../../core/tabs";

/**
 * Walking into a conversation, as today's client does (`stream/Stream.tsx`):
 * pin the "you left off here" line, let go of other rooms' scrollback (#173),
 * and load the history around where you left off, or the newest. Once per
 * visit, after the read positions are in; again after a reconnect, which may
 * have made the loaded history stale.
 *
 * A room that is already being opened when the visit starts is not opened
 * again. That is a search hit or a media tile opening its room at the
 * message (ChatWindow's `goToMessage`, just before the tab shows), or the
 * last visit's first page still on its way. Opening it a second time would
 * start the room over, and the store drops a page asked for before that
 * (#266), so the visit waits for the opening already on its way instead.
 */
export function useLanding(api: AuthedApi | null, roomId: RoomId | null, state: GatewayState | null): { ready: boolean; at: "left-off" | "end" } {
  const readLoaded = state?.readLoaded ?? false;
  const sessionId = state?.sessionId ?? null;
  const key = api && roomId !== null ? `${api.baseUrl}#${roomId}` : "";
  const [land, setLand] = useState<{ key: string; ready: boolean; at: "left-off" | "end" }>({ key: "", ready: false, at: "end" });

  useEffect(() => {
    if (!api || roomId === null || !readLoaded) return;
    const server = api.baseUrl;
    const here = `${server}#${roomId}`;
    let alive = true;
    let stopWaiting = (): void => undefined;
    const current = serverState(server);
    const target = openingAt(current, roomId);
    const stream = current.streams[roomId];
    enterRoom(server, roomId);
    releaseOtherRooms(server, roomId);
    const at = target === null ? "end" : "left-off";
    setLand({ key: here, ready: false, at });
    const landed = () => {
      if (alive) setLand({ key: here, ready: true, at });
    };
    if (stream && stream.loading && stream.messages.length === 0) {
      stopWaiting = whenOpened(server, roomId, landed);
    } else {
      void (async () => {
        if (target !== null) await openAround(api, roomId, target);
        else if (stream && !stream.atEnd) await leaveWindow(api, roomId);
        else await openRoom(api, roomId);
        landed();
      })();
    }
    return () => {
      alive = false;
      stopWaiting();
    };
  }, [api, roomId, readLoaded, sessionId]);

  const ready = land.key === key && land.ready;
  const at = land.key === key ? land.at : "end";
  // One object per change, so the conversation isn't redrawn by every update to the store.
  return useMemo(() => ({ ready, at }), [ready, at]);
}

/**
 * Call `landed` once the room's opening on its way has come back, or the room
 * has been let go of. Answers how to stop waiting.
 */
function whenOpened(server: string, roomId: RoomId, landed: () => void): () => void {
  let stop = (): void => undefined;
  const check = () => {
    const stream = serverState(server).streams[roomId];
    if (stream !== undefined && stream.loading) return;
    stop();
    landed();
  };
  stop = onStateChange(check);
  check();
  return stop;
}

/**
 * You have read what you can see: the newest message is on screen, the
 * conversation is at its end, and this window has your attention. A
 * conversation open on a second screen while you type elsewhere hasn't been
 * read, and marking it would eat the line that says where you stopped. The
 * owner keeps read positions, so this asks it (core/share.ts, "read").
 */
export function useReading(
  intend: Following["intend"],
  active: TabKey | null,
  state: GatewayState | null,
  landed: boolean,
): (id: MessageId) => void {
  const seen = useRef<{ tab: string; id: MessageId } | null>(null);
  // What was last asked for, so the owner hears each position once.
  const asked = useRef<{ tab: string; id: MessageId } | null>(null);
  const atEnd = active && state ? (state.streams[active.roomId]?.atEnd ?? false) : false;
  const tab = active ? keyOf(active) : "";

  const mark = useCallback(() => {
    const newest = seen.current;
    if (!active || !newest || newest.tab !== tab || !landed || !atEnd) return;
    if (!document.hasFocus() || document.visibilityState !== "visible") return;
    if (asked.current?.tab === tab && asked.current.id === newest.id) return;
    asked.current = newest;
    void intend({ kind: "read", server: active.server, roomId: active.roomId, messageId: newest.id }).catch(() => undefined);
  }, [active, tab, landed, atEnd, intend]);
  const markNow = useRef(mark);
  markNow.current = mark;

  // Coming back to the window with the newest message on screen is reading it.
  useEffect(() => {
    const onFocus = () => markNow.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return useCallback(
    (id: MessageId) => {
      seen.current = { tab, id };
      markNow.current();
    },
    [tab],
  );
}
