import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useNow } from "../../../lib/clock";
import {
  connect,
  disconnect,
  type GatewayState,
  leaveVoice,
  loadNotifyRules,
  noteDm,
  saveStatus,
  loadReadMarkers,
  setVoiceDeafened,
  setVoiceMuted,
  useGateway,
} from "../../../lib/gateway";
import { PUSH_TO_TALK_KEY } from "../../../lib/voice";
import { forgetNotifications, resetNotifications } from "../../../lib/notify";
import { forgetPreviews } from "../../../lib/previews";
import { type ServerSession, useSessions } from "../../../lib/session";
import { dropPresence, setAway, setPresenceLive, setPresenceRoom, startPresence } from "../../../lib/watchPresence";
import type { RoomId } from "../../../generated/RoomId";
import { tauriBus } from "../../core/bus";
import { listModel } from "../../core/list";
import { talkingNow, voiceModel } from "../../core/voice";
import { awayChoices, rememberAway, withAway, withLine } from "../../core/you";
import type { YouActions } from "./YouCard";
import { type Sharing, shareAsOwner, type WindowOpener } from "../../core/share";
import { Spinner } from "../../kit";
import { WindowMessage } from "../WindowMessage";
import { ListView } from "./ListView";
import type { KnockResult } from "./PersonCard";
import type { VoiceDockProps } from "./VoiceDock";
import { ApiError, TransportError } from "../../../lib/api";
import type { User } from "../../../generated/User";

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
    let held: Sharing | null = null;
    let gone = false;
    void shareAsOwner(tauriBus(), () => new Map([[baseUrl, api]]), shell).then((started) => {
      if (gone) started.stop();
      else held = sharing = started;
    });
    return () => {
      gone = true;
      held?.stop();
      if (sharing === held) sharing = null;
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

  // Your status line and away, from the top card. The status is saved as a
  // whole (every other field carried over) the way today's client saves it,
  // then presence is told you're away or back (lib/watchPresence).
  const me = gateway.me;
  const you = useMemo<YouActions | undefined>(() => {
    if (me === null) return undefined;
    return {
      awayChoices: awayChoices(loadRecentAway()),
      saveLine: (line) => said(saveStatus(api, withLine(me.status, line))),
      goAway: async (message) => {
        const problem = await said(saveStatus(api, withAway(me.status, message)));
        if (problem === null) {
          setAway(baseUrl, message);
          saveRecentAway(rememberAway(loadRecentAway(), message));
        }
        return problem;
      },
      comeBack: async () => {
        const problem = await said(saveStatus(api, withAway(me.status, null)));
        if (problem === null) setAway(baseUrl, null);
        return problem;
      },
    };
  }, [api, baseUrl, me]);

  return (
    <ListView
      serverName={serverName ?? hostOf(baseUrl)}
      model={model}
      speaking={speaking}
      voice={voice}
      you={you}
      onOpenRoom={(room) => openChat(baseUrl, room)}
      onOpenDm={(room) => openChat(baseUrl, room)}
      onMessage={(user) => void messageWith(api, user)}
      onKnock={(user) => knock(api, user)}
      onStartDm={(people) => startDm(api, people)}
      onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
    />
  );
}

/** A save's outcome as the top card wants it: null, or what went wrong in words. */
async function said(saving: Promise<unknown>): Promise<string | null> {
  try {
    await saving;
    return null;
  } catch (error: unknown) {
    // The server's own words when it has any (PROTOCOL §1: written to be shown).
    return error instanceof ApiError ? error.message : "Couldn't save that. The server didn't answer.";
  }
}

/** Your own recent away messages, remembered on this computer only. */
const RECENT_AWAY = "linger.next.recentAway";

function loadRecentAway(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_AWAY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecentAway(recent: string[]): void {
  try {
    window.localStorage.setItem(RECENT_AWAY, JSON.stringify(recent));
  } catch {
    // Storage refused: the presets still work, this is a convenience.
  }
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

/**
 * Open the DM with exactly these people from the new-message picker: the
 * server hands back the one you already have, or makes it (SPEC §4.13).
 */
async function startDm(api: ServerSession["api"], people: User[]): Promise<string | null> {
  try {
    const dm = await api.openDm(people.map((person) => person.id));
    noteDm(api.baseUrl, dm);
    openChat(api.baseUrl, dm.id);
    return null;
  } catch (error: unknown) {
    return error instanceof ApiError || error instanceof TransportError ? error.message : "Couldn't open the DM.";
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

/** The desktop shell's window commands (src-tauri/src/window.rs); only this window may call them. */
const shell: WindowOpener = {
  chat: (server, roomId) => {
    if (!isTauri()) return;
    void invoke("next_open_chat", { server, room: roomId }).catch((error: unknown) => console.error("could not open the chat window", error));
  },
  conversation: (server, roomId, kind) => {
    if (!isTauri()) return;
    void invoke("next_open_conversation", { server, room: roomId, kind }).catch((error: unknown) =>
      console.error("could not open the conversation's window", error),
    );
  },
};

/** This window's sharing, once it has started: it knows which conversations have their own windows. */
let sharing: Sharing | null = null;

/**
 * Show a conversation: in its own window if it was popped out into one,
 * otherwise as a tab in the chat window (core/share.ts, `open`).
 */
function openChat(server: string, room: RoomId): void {
  if (sharing) sharing.open(server, room);
  else shell.chat(server, room);
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
