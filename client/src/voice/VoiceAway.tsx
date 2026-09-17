import { useCallback, useEffect, useState } from "react";
import type { RoomId } from "../generated/RoomId";
import { dmLabel } from "../dm/dm";
import { useServers } from "../lib/gateway";
import { hostOf } from "../lib/link";
import type { ServerSession } from "../lib/session";
import VoiceControls from "./VoiceControls";

/** Keep the ongoing room reachable when its stream is not on screen. */
export default function VoiceAway({
  servers,
  visibleServer,
  visibleRoom,
  onReturn,
}: {
  servers: ServerSession[];
  visibleServer: string;
  visibleRoom: RoomId | null;
  onReturn: (server: string, room: RoomId) => void;
}) {
  const all = useServers();
  const session = servers.find((item) => all[item.baseUrl]?.myVoice != null);
  const server = session?.baseUrl;
  const state = server === undefined ? undefined : all[server];
  const mine = state?.myVoice;
  const [problem, setProblem] = useState<string | null>(null);
  const controlProblem = useCallback((error: unknown): void => {
    setProblem(
      error instanceof Error
        ? error.message
        : "Couldn't change voice controls.",
    );
  }, []);
  useEffect(() => {
    if (mine != null) setProblem(null);
  }, [server, mine?.roomId]);

  const inView = server === visibleServer && mine?.roomId === visibleRoom;
  if (inView || (mine == null && problem === null)) return null;
  const room =
    state === undefined
      ? undefined
      : [...state.rooms, ...state.dms].find((item) => item.id === mine?.roomId);
  const name =
    room === undefined
      ? "voice room"
      : room.kind === "dm"
        ? dmLabel(room, state?.users ?? [], state?.me?.id ?? null)
        : `#${room.slug}`;

  return (
    <section className="voice-away" aria-label="Ongoing voice">
      {mine != null && server !== undefined ? (
        <>
          <div className="voice-away-room">
            <span className="panel-label">In voice</span>
            <button
              type="button"
              className="voice-action"
              onClick={() => onReturn(server, mine.roomId)}
            >
              Return to {name}
              {server === visibleServer ? "" : ` · ${hostOf(server)}`}
            </button>
          </div>
          <VoiceControls
            server={server}
            mine={mine}
            onProblem={controlProblem}
          />
        </>
      ) : null}
      {problem === null ? null : (
        <div className="voice-problem" role="alert">
          {problem}
          <button
            type="button"
            className="voice-action"
            onClick={() => setProblem(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
