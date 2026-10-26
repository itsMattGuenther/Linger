import { useEffect, useMemo, useState } from "react";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import type { AuthedApi } from "../../../lib/api";
import type { GatewayState } from "../../../lib/gateway";
import { hasWebCodecs, useSharesFromHere } from "../../../lib/screen/probe";
import { useScreenShare } from "../../../lib/screen/share";
import { awaitNext, closeEnded, drawOn, startWatching, stopWatching, useScreenWatch, watchNext, watchOver } from "../../../lib/screen/watch";
import { onPhone } from "../../core/phone";
import { myScreen, seatedIn, shareBy, sharersIn, watchersOf } from "../../core/screens";
import { startSharingHere, stopSharingEverywhere } from "../../core/screenStop";
import type { Intent } from "../../core/share";
import type { ChatPane } from "../chat/ChatView";
import type { ShareControl } from "./ShareButton";

/** How long a Watch waits for its voice seat before it gives up. */
const SEAT_WAIT_MS = 15_000;

/**
 * Screens in the showing conversation's voice (SPEC §4.20, #360), for the
 * pane: the share this window shows above the conversation, who shares,
 * Watch, and Share. Watch joins voice first when you aren't in it, and the
 * screen opens once the server has given you a seat there. Leaving voice, or
 * moving it, closes the screen. A screen left open after its share ended
 * opens the same person's next share in that voice by itself.
 */
export function usePaneScreen({
  server,
  api,
  state,
  roomId,
  intend,
  screensOn,
}: {
  server: string | null;
  api: AuthedApi | null;
  state: GatewayState | null;
  roomId: RoomId | null;
  intend: (intent: Intent) => Promise<void>;
  /** The server passes screens on (`GET /server`'s `screens`). */
  screensOn: boolean;
}): ChatPane["screen"] | undefined {
  const watch = useScreenWatch();
  const share = useScreenShare();
  // A Watch pressed outside voice, waiting for its seat.
  const [pending, setPending] = useState<{ server: string; roomId: RoomId; target: string; who: string; at: number } | null>(null);

  const seatedHere = state !== null && roomId !== null && seatedIn(state, roomId);
  const canShare = useSharesFromHere(seatedHere && screensOn && !onPhone());
  useEffect(() => {
    if (!pending || !api || !state || server !== pending.server || state.sessionId === null) return;
    if (seatedIn(state, pending.roomId)) {
      setPending(null);
      void startWatching({ server, api, sessionId: state.sessionId, target: pending.target, place: pending.roomId, who: pending.who });
      return;
    }
    const left = SEAT_WAIT_MS - (Date.now() - pending.at);
    if (left <= 0) {
      setPending(null);
      return;
    }
    const timer = window.setTimeout(() => setPending((held) => (held === pending ? null : held)), left);
    return () => window.clearTimeout(timer);
  }, [pending, api, state, server]);

  // Out of voice where it was watching: the screen goes too.
  const watchHere = watch !== null && watch.server === server;
  const stillSeated = watchHere && state !== null && seatedIn(state, watch.place);
  useEffect(() => {
    if (watchHere && !stillSeated && pending === null && !watchOver(watch?.status)) stopWatching();
  }, [watchHere, stillSeated, pending, watch?.status]);

  // An ended screen still open: once its person has stopped sharing, their
  // next share here opens on it, while you're still in that voice.
  const over = watchHere && watchOver(watch.status);
  const theirs = over && state !== null ? shareBy(state, watch.place, watch.who) : null;
  const awaitsNext = over && watch.awaitsNext === true;
  useEffect(() => {
    if (!over || pending !== null) return;
    if (theirs === null) {
      awaitNext();
      return;
    }
    if (awaitsNext && stillSeated && server && api && state?.sessionId) void watchNext({ server, api, sessionId: state.sessionId, target: theirs });
  }, [over, theirs, awaitsNext, stillSeated, pending, server, api, state?.sessionId]);

  return useMemo(() => {
    if (!server || !state || roomId === null || !screensOn || !hasWebCodecs()) return undefined;
    const users = new Map(state.users.map((user) => [user.id, user]));
    const sharers = sharersIn(state, roomId);
    const me = state.sessionId;
    const mine = myScreen(state);
    const sharing = new Set(sharers.map((one) => one.userId));
    const others = sharers.filter((one) => one.session !== me).flatMap((one) => {
      const user = users.get(one.userId);
      return user ? [{ session: one.session, user }] : [];
    });
    const shownHere = watch !== null && watch.server === server && watch.place === roomId ? watch : null;
    const onWatch = (session: string) => {
      const who = sharers.find((one) => one.session === session)?.userId ?? "";
      if (!api || state.sessionId === null) return;
      if (seatedIn(state, roomId)) {
        void startWatching({ server, api, sessionId: state.sessionId, target: session, place: roomId, who });
        return;
      }
      setPending({ server, roomId, target: session, who, at: Date.now() });
      void intend({ kind: "voice.join", server, roomId }).catch(() => setPending(null));
    };
    const iShare = (mine?.roomId === roomId && mine.sharing) || (share !== null && share.server === server);
    const shareControl: ShareControl | undefined =
      seatedHere && canShare
        ? {
            sharing: iShare,
            unavailable: !iShare && sharers.length >= 3 ? "Three people are sharing here already." : undefined,
            onShare: (fps) => {
              if (!api || state.sessionId === null) return;
              void startSharingHere({ server, api, sessionId: state.sessionId, fps });
            },
            onStop: stopSharingEverywhere,
          }
        : undefined;
    const stage = shownHere
      ? {
          sharer: users.get(shownHere.who) ?? null,
          others: watchersOf(state, roomId, shownHere.target)
            .filter((id) => id !== state.me?.id)
            .flatMap((id): User[] => {
              const user = users.get(id);
              return user ? [user] : [];
            }),
          status: shownHere.status,
          opensNext: watchOver(shownHere.status) && seatedIn(state, shownHere.place),
          onClose: () => {
            stopWatching();
            closeEnded();
          },
          onCanvas: drawOn,
        }
      : null;
    return {
      stage,
      sharing,
      watch: others.length > 0 ? { sharers: others, watching: watchOver(shownHere?.status) ? null : (shownHere?.target ?? null), onWatch } : undefined,
      share: shareControl,
    };
  }, [server, state, roomId, screensOn, watch, share, api, intend, seatedHere, canShare]);
}
