import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNow } from "../../../lib/clock";
import {
  connect,
  disconnect,
  type GatewayState,
  loadNotifyRules,
  loadReadMarkers,
  useGateway,
} from "../../../lib/gateway";
import { forgetNotifications, resetNotifications } from "../../../lib/notify";
import { forgetPreviews } from "../../../lib/previews";
import { type ServerSession, useSessions } from "../../../lib/session";
import { dropPresence, setPresenceLive, setPresenceRoom, startPresence } from "../../../lib/watchPresence";
import { listModel } from "../../core/list";
import { Spinner, TitleBar } from "../../kit";
import { LogoMark } from "../LogoMark";
import { ListView } from "./ListView";
import "./ListWindow.css";

/** How often the server's name is asked for again. It changes about once ever. */
const INFO_REFRESH_MS = 120_000;

/**
 * The buddy list window: the owner (docs/design/architecture.md). It restores
 * the sign-ins, connects to each server, watches presence and draws the list.
 *
 * One server for now: several servers as folding sections are M15.8.
 */
export function ListWindow() {
  const sessions = useSessions();

  if (sessions.state.status === "restoring") {
    return (
      <WindowMessage>
        <Spinner />
        <span>Signing you back in…</span>
      </WindowMessage>
    );
  }

  const [first] = sessions.state.servers;
  if (first === undefined) {
    // The new client's sign-in comes later (docs/design/parity.md, SIGN-*).
    return (
      <WindowMessage>
        <span>You're not signed in to a server here yet.</span>
        <span className="nx-window-hint">Sign in with today's Linger first, then open this one again.</span>
      </WindowMessage>
    );
  }

  return <ServerList session={first} />;
}

function ServerList({ session }: { session: ServerSession }) {
  const { api, baseUrl } = session;
  const gateway = useGateway(baseUrl);
  const now = useNow();
  const [serverName, setServerName] = useState<string | null>(null);

  // One presence watcher for the window, for as long as it is open.
  useEffect(() => {
    const stop = startPresence();
    return () => {
      stop();
      resetNotifications();
    };
  }, []);

  // The connection, owned by this window and closed when it goes. The same
  // shape as today's client (App.tsx, ServerLink), which is what keeps a
  // StrictMode remount from leaving a socket nobody follows.
  useEffect(() => {
    void connect(api);
    return () => {
      forgetNotifications(baseUrl);
      forgetPreviews(baseUrl);
      dropPresence(baseUrl);
      void disconnect(baseUrl);
    };
  }, [api, baseUrl]);

  useEffect(() => {
    void loadReadMarkers(api);
    void loadNotifyRules(api).catch(() => undefined);
  }, [api]);

  // Around, in no room: rooms open in the chat window (M15.2).
  useEffect(() => {
    setPresenceRoom(baseUrl, null);
  }, [baseUrl]);
  useEffect(() => {
    setPresenceLive(baseUrl, gateway.status.kind === "ready");
  }, [baseUrl, gateway.status.kind]);

  const asOf = useNow(INFO_REFRESH_MS);
  useEffect(() => {
    const abort = new AbortController();
    void api
      .serverInfo(abort.signal)
      .then((info) => setServerName(info.name))
      .catch(() => undefined);
    return () => abort.abort();
  }, [api, asOf]);

  const model = useMemo(() => listModel(gateway, now), [gateway, now]);
  const speaking = useMemo(() => talkingNow(gateway), [gateway]);

  return (
    <ListView
      serverName={serverName ?? hostOf(baseUrl)}
      model={model}
      speaking={speaking}
      onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
    />
  );
}

/**
 * Who is talking, by user id. Only known while you are in voice yourself:
 * speaking comes from the audio you are hearing, never from the server.
 */
function talkingNow(state: GatewayState): ReadonlySet<string> {
  const mine = state.myVoice;
  if (mine === null) return new Set();
  const peers = state.voice[mine.roomId] ?? [];
  const bySession = new Map(peers.map((peer) => [peer.session_id, peer.user_id]));
  const ids = Object.entries(mine.speaking)
    .filter(([, on]) => on)
    .map(([session]) => bySession.get(session))
    .filter((id): id is string => id !== undefined);
  return new Set(ids);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** A window with nothing to list yet: the title bar, and a quiet line. */
function WindowMessage({ children }: { children: ReactNode }) {
  return (
    <div className="nx-window">
      <TitleBar leading={<LogoMark />} onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}>
        Linger
      </TitleBar>
      <div className="nx-window-message" role="status">
        {children}
      </div>
    </div>
  );
}
