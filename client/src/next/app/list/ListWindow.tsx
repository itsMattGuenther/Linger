import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNow } from "../../../lib/clock";
import {
  connect,
  disconnect,
  type GatewayState,
  leaveVoice,
  loadNotifyRules,
  noteDm,
  loadReadMarkers,
  setVoiceDeafened,
  setVoiceMuted,
  useGateway,
} from "../../../lib/gateway";
import { PUSH_TO_TALK_KEY } from "../../../lib/voice";
import { forgetNotifications, resetNotifications } from "../../../lib/notify";
import { forgetPreviews } from "../../../lib/previews";
import { type ServerSession, useSessions } from "../../../lib/session";
import { dropPresence, setPresenceLive, setPresenceRoom, startPresence } from "../../../lib/watchPresence";
import type { RoomId } from "../../../generated/RoomId";
import { tauriBus } from "../../core/bus";
import { listModel } from "../../core/list";
import { talkingNow, voiceModel } from "../../core/voice";
import { shareAsOwner } from "../../core/share";
import { Spinner, TitleBar } from "../../kit";
import { LogoMark } from "../LogoMark";
import { ListView } from "./ListView";
import type { KnockResult } from "./PersonCard";
import type { VoiceDockProps } from "./VoiceDock";
import { ApiError, TransportError } from "../../../lib/api";
import type { User } from "../../../generated/User";
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

  // The owner's half of sharing this connection with the chat window
  // (docs/design/architecture.md): snapshots, lent tokens, intents.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void shareAsOwner(tauriBus(), () => new Map([[baseUrl, api]])).then((unshare) => {
      if (gone) unshare();
      else stop = unshare;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [api, baseUrl]);

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
  const pushToTalk = gateway.myVoice?.pushToTalk ?? false;

  // Push-to-talk while the list has focus, as today's client does; a chat
  // window reports its own key presses (core/share.ts, "voice.talk").
  useEffect(() => {
    if (!pushToTalk) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === PUSH_TO_TALK_KEY && !event.repeat) void setVoiceMuted(baseUrl, false).catch(() => undefined);
    };
    const release = () => void setVoiceMuted(baseUrl, true).catch(() => undefined);
    const up = (event: KeyboardEvent) => {
      if (event.key === PUSH_TO_TALK_KEY) release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [baseUrl, pushToTalk]);

  const voice = useMemo(() => voiceDock(gateway, speaking, baseUrl), [gateway, speaking, baseUrl]);

  return (
    <ListView
      serverName={serverName ?? hostOf(baseUrl)}
      model={model}
      speaking={speaking}
      voice={voice}
      onOpenRoom={(room) => openChat(baseUrl, room)}
      onOpenDm={(room) => openChat(baseUrl, room)}
      onMessage={(user) => void messageWith(api, user)}
      onKnock={(user) => knock(api, user)}
      onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
    />
  );
}

/**
 * Open a DM with somebody: the server finds the one you already have, or makes
 * it (SPEC §4.13), and the chat window shows it.
 */
async function messageWith(api: ServerSession["api"], user: User): Promise<void> {
  try {
    const dm = await api.openDm([user.id]);
    noteDm(api.baseUrl, dm);
    openChat(api.baseUrl, dm.id);
  } catch (error: unknown) {
    console.error("could not open a DM", error);
  }
}

/** Knock, and say plainly what happened (SPEC §4.9), in today's client's words. */
async function knock(api: ServerSession["api"], user: User): Promise<KnockResult> {
  try {
    await api.knock(user.id);
    return { ok: true };
  } catch (error: unknown) {
    const problem =
      error instanceof ApiError && error.code === "RATE_LIMITED"
        ? "That's three this hour. Give them a bit."
        : error instanceof ApiError || error instanceof TransportError
          ? error.message
          : "Couldn't knock.";
    return { ok: false, problem };
  }
}

/**
 * Open the chat window on a conversation, or show it in the one that is open
 * (src-tauri/src/window.rs, `next_open_chat`).
 */
function openChat(server: string, room: RoomId): void {
  if (!isTauri()) return;
  void invoke("next_open_chat", { server, room }).catch((error: unknown) => {
    console.error("could not open the chat window", error);
  });
}

/**
 * The voice bar: what it shows comes from the store (core/voice.ts); its
 * controls act here, in the owner, which keeps the voice seat.
 */
function voiceDock(state: GatewayState, speaking: ReadonlySet<string>, server: string): VoiceDockProps | undefined {
  const model = voiceModel(state, speaking);
  if (model === null) return undefined;
  return {
    ...model,
    onGoToRoom: () => openChat(server, model.roomId),
    onMute: (muted) => void setVoiceMuted(server, muted).catch(() => undefined),
    onDeafen: (deafened) => void setVoiceDeafened(server, deafened).catch(() => undefined),
    onLeave: () => void leaveVoice(server).catch(() => undefined),
  };
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
