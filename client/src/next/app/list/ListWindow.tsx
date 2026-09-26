import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../../lib/clock";
import {
  connect,
  disconnect,
  dismissKnock,
  type GatewayState,
  leaveVoice,
  loadNotifyRules,
  noteDm,
  saveStatus,
  loadReadMarkers,
  setVoiceDeafened,
  setVoiceMuted,
  setVoiceVolume,
  useGateway,
  useServers,
} from "../../../lib/gateway";
import { PUSH_TO_TALK_KEY } from "../../../lib/voice";
import { forgetNotifications, resetNotifications, setQuietServers } from "../../../lib/notify";
import { forgetPreviews } from "../../../lib/previews";
import { type ServerSession, useSessions } from "../../../lib/session";
import { dropPresence, setAway, setPresenceLive, setPresenceRoom, startPresence } from "../../../lib/watchPresence";
import type { RoomId } from "../../../generated/RoomId";
import { PROTOCOL, tauriBus } from "../../core/bus";
import { isSearchKey, isSettingsKey } from "../../core/keys";
import { listModel } from "../../core/list";
import { inOrder, loadServerPrefs, saveServerPrefs, type ServerPrefs } from "../../core/serverPrefs";
import { moveServer, seatsWords, serverHeader } from "../../core/servers";
import { talkingNow, voiceModel } from "../../core/voice";
import { awayChoices, rememberAway, withAway, withLine } from "../../core/you";
import type { YouActions } from "./YouCard";
import {
  type Accounts,
  leftOut,
  type ListControls,
  SERVER_PREFS,
  type ServerPrefsMessage,
  type Sharing,
  SIGNED_IN,
  SIGNED_OUT,
  type SignedInMessage,
  type SignedOutMessage,
  shareAsOwner,
  type WindowOpener,
} from "../../core/share";
import { loadCloseList } from "../../core/closing";
import { listNotes, TROUBLE_GRACE_MS, troubleSince, UPDATE_EVERY_MS } from "../../core/notes";
import { checkForUpdate, type UpdateCheck } from "../../../lib/updates";
import { ListNotes } from "./ListNotes";
import { knockOn } from "../../core/knock";
import { readPasted, type SignInActions, signInActions } from "../../core/signin";
import { Spinner } from "../../kit";
import { SignInView } from "../signin/SignInView";
import { WindowMessage } from "../WindowMessage";
import { ListView } from "./ListView";
import type { ServerListing } from "./ServerSection";
import type { AwayEverywhere } from "./YouEverywhere";
import { type KnockCard, KnockCards } from "./KnockCards";
import { VoiceDock, type VoiceDockProps } from "./VoiceDock";
import { ApiError, PublicApi, TransportError } from "../../../lib/api";
import type { ServerInfo } from "../../../generated/ServerInfo";
import type { User } from "../../../generated/User";

/** How often the server's name is asked for again. It changes about once ever. */
const INFO_REFRESH_MS = 120_000;

/**
 * The buddy list window: the owner (docs/design/architecture.md). It restores
 * the sign-ins, connects to each server, watches presence and draws the list:
 * one server's list, or a section per server with several (T-1809).
 */
export function ListWindow() {
  const sessions = useSessions();
  const { addServer } = sessions;
  const signIn = useMemo(() => signInActions((baseUrl) => new PublicApi(baseUrl), addServer), [addServer]);

  // Every window hears when a server is signed out of, however it happened
  // (Settings, a sign-in that ran out, all of them at once), so none goes on
  // working as you there, and when one is signed in to, so each can open it
  // (SIGNED_OUT and SIGNED_IN in core/share.ts).
  const signedIn = sessions.state.status === "ready" ? sessions.state.servers.map((session) => session.baseUrl) : null;
  const signedInKey = signedIn === null ? null : signedIn.join(" ");
  const wasSignedIn = useRef<string[] | null>(null);
  useEffect(() => {
    if (signedInKey === null) return;
    const now = signedInKey === "" ? [] : signedInKey.split(" ");
    const before = wasSignedIn.current;
    wasSignedIn.current = now;
    if (before === null || !isTauri()) return;
    const bus = tauriBus();
    for (const server of leftOut(before, now)) {
      const message: SignedOutMessage = { v: PROTOCOL, server };
      void bus.broadcast(SIGNED_OUT, message);
    }
    // And when one is signed in to, open windows take it up (SIGNED_IN).
    for (const server of leftOut(now, before)) {
      const message: SignedInMessage = { v: PROTOCOL, server };
      void bus.broadcast(SIGNED_IN, message);
    }
  }, [signedInKey]);

  if (sessions.state.status === "restoring") {
    return (
      <WindowMessage>
        <Spinner />
        <span>Signing you back in…</span>
      </WindowMessage>
    );
  }

  if (sessions.state.servers.length === 0) {
    // Signing in lives here until decision 16 says otherwise (parity SIGN-1).
    return (
      <SignInView
        actions={signIn}
        notice={sessions.notice}
        keyringNotice={sessions.keyringNotice}
        onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
      />
    );
  }

  const accounts: Accounts = {
    reauthenticate: (server, auth) => sessions.addServer(server, auth),
    signOut: (server) => sessions.signOut(server),
  };
  return <Servers signedIn={sessions.state.servers} accounts={accounts} keyringNotice={sessions.keyringNotice} />;
}

/**
 * One server's connection, owned by this window and closed when it goes: no
 * UI of its own. The same shape as today's client (App.tsx, ServerLink), which
 * is what keeps a StrictMode remount from leaving a socket nobody follows.
 */
function ServerLink({ session, onInfo }: { session: ServerSession; onInfo: (server: string, info: ServerInfo) => void }) {
  const { api, baseUrl } = session;
  const status = useGateway(baseUrl).status.kind;

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

  // Around, in no room: rooms open in the chat window, which tells the owner.
  useEffect(() => {
    setPresenceRoom(baseUrl, null);
  }, [baseUrl]);
  useEffect(() => {
    setPresenceLive(baseUrl, status === "ready");
  }, [baseUrl, status]);

  // Its name and color. They change about once ever.
  const asOf = useNow(INFO_REFRESH_MS);
  useEffect(() => {
    const abort = new AbortController();
    void api
      .serverInfo(abort.signal)
      .then((info) => onInfo(baseUrl, info))
      .catch(() => undefined);
    return () => abort.abort();
  }, [api, baseUrl, asOf, onInfo]);

  return null;
}

function Servers({ signedIn, accounts, keyringNotice }: { signedIn: ServerSession[]; accounts: Accounts; keyringNotice: string | null }) {
  const states = useServers();
  const now = useNow();
  const [prefs, setPrefs] = useState<ServerPrefs>(() => loadServerPrefs(localStore()));
  const ordered = useMemo(() => inOrder(signedIn, prefs.order), [signedIn, prefs.order]);
  const quiet = useMemo(() => new Set(prefs.quiet), [prefs.quiet]);
  const [infos, setInfos] = useState<Readonly<Record<string, ServerInfo>>>({});
  const onInfo = useCallback((server: string, info: ServerInfo) => setInfos((held) => ({ ...held, [server]: info })), []);
  const several = ordered.length > 1;

  const changePrefs = (next: ServerPrefs) => {
    setPrefs(next);
    saveServerPrefs(localStore(), next);
  };

  // Settings shows your servers' order and Quiet, whichever window changed them.
  useEffect(() => {
    if (!isTauri()) return;
    const message: ServerPrefsMessage = { v: PROTOCOL, prefs };
    void tauriBus().broadcast(SERVER_PREFS, message);
  }, [prefs]);

  // Adding a server (Settings → Servers, or Account & App with one): the
  // sign-in takes the list's place, and every server stays connected.
  const [adding, setAdding] = useState(false);
  // A server you're already on isn't signed in to again: that would restart
  // its connection, and your voice seat with it.
  const alreadyOn = useRef<(baseUrl: string) => string | null>(() => null);
  alreadyOn.current = (baseUrl) =>
    signedIn.some((session) => session.baseUrl === baseUrl) ? `You're already signed in to ${infos[baseUrl]?.name ?? hostOf(baseUrl)}.` : null;
  const addingActions = useMemo((): SignInActions => {
    const actions = signInActions(
      (baseUrl) => new PublicApi(baseUrl),
      async (baseUrl, auth) => {
        await accounts.reauthenticate(baseUrl, auth);
        setAdding(false);
      },
    );
    return {
      ...actions,
      check: async (pasted) => {
        const read = readPasted(pasted);
        const problem = "link" in read ? alreadyOn.current(read.link.baseUrl) : null;
        return problem === null ? actions.check(pasted) : { problem };
      },
    };
  }, [accounts]);
  const listNow = useRef<ListControls>({ addServer: () => undefined, setPrefs: () => undefined });
  listNow.current = {
    addServer: () => {
      setAdding(true);
      if (isTauri()) {
        const current = getCurrentWindow();
        void current
          .unminimize()
          .then(() => current.setFocus())
          .catch(() => undefined);
      }
    },
    setPrefs: changePrefs,
  };

  // One presence watcher for the window, for as long as it is open.
  useEffect(() => {
    const stop = startPresence();
    return () => {
      stop();
      resetNotifications();
    };
  }, []);

  // A quiet server makes no sound (lib/notify.ts); its knocks still get through.
  useEffect(() => setQuietServers(quiet), [quiet]);

  // The owner's half of sharing these connections with the other windows
  // (docs/design/architecture.md): snapshots, lent tokens, intents. It reads
  // the signed-in servers when asked, so signing in or out needs no restart.
  const apisRef = useRef(new Map<string, ServerSession["api"]>());
  apisRef.current = new Map(signedIn.map((session) => [session.baseUrl, session.api]));
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  useEffect(() => {
    if (!isTauri()) return;
    const accountsNow: Accounts = {
      reauthenticate: (server, auth) => accountsRef.current.reauthenticate(server, auth),
      signOut: (server) => accountsRef.current.signOut(server),
    };
    let held: Sharing | null = null;
    let gone = false;
    const list: ListControls = {
      addServer: () => listNow.current.addServer(),
      setPrefs: (next) => listNow.current.setPrefs(next),
      closeToTray: (on) => closeToTray(on),
    };
    // What closing the list does, as kept on this computer (core/closing.ts).
    closeToTray(loadCloseList(localStore()) === "tray");
    void shareAsOwner(tauriBus(), () => apisRef.current, { opener: shell, store: localStore(), accounts: accountsNow, list }).then((started) => {
      if (gone) started.stop();
      else held = sharing = started;
    });
    return () => {
      gone = true;
      held?.stop();
      if (sharing === held) sharing = null;
    };
  }, []);

  // A server signed back into starts its presence afresh (ServerLink):
  // sharing puts you back in the room you're in.
  useEffect(() => {
    sharing?.signInsChanged();
  }, [signedIn]);

  // Ctrl+, opens Settings from the list too, and Ctrl+K Search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isSearchKey(event)) {
        event.preventDefault();
        shell.tool("search");
        return;
      }
      if (!isSettingsKey(event)) return;
      event.preventDefault();
      shell.settings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Your voice seat, on whichever server has it: one at a time (SPEC §4.14).
  const voiceServer = ordered.find((session) => states[session.baseUrl]?.myVoice)?.baseUrl ?? null;
  const voiceState = voiceServer === null ? undefined : states[voiceServer];
  const pushToTalk = voiceState?.myVoice?.pushToTalk ?? false;

  // Push-to-talk while the list has focus, as today's client does; a chat
  // window reports its own key presses (core/share.ts, "voice.talk").
  useEffect(() => {
    if (!pushToTalk || voiceServer === null) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === PUSH_TO_TALK_KEY && !event.repeat) void setVoiceMuted(voiceServer, false).catch(() => undefined);
    };
    const release = () => void setVoiceMuted(voiceServer, true).catch(() => undefined);
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
  }, [voiceServer, pushToTalk]);

  // The tray menu's Mute and Leave (decision 5): the only ones in reach while
  // the list is hidden in the tray. The shell greys them out out of voice.
  const trayMuted = voiceState?.myVoice?.muted ?? false;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("next_tray_voice", { inVoice: voiceServer !== null, muted: trayMuted }).catch(() => undefined);
  }, [voiceServer, trayMuted]);
  const trayVoice = useRef<(action: string) => void>(() => undefined);
  trayVoice.current = (action) => {
    if (voiceServer === null) return;
    if (action === "mute") void setVoiceMuted(voiceServer, !trayMuted).catch(() => undefined);
    if (action === "leave") void leaveVoice(voiceServer).catch(() => undefined);
  };
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<string>("next:tray", (action) => trayVoice.current(action))
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  const voice = useMemo(() => {
    if (!voiceState || voiceServer === null) return undefined;
    const dock = voiceDock(voiceState, talkingNow(voiceState), voiceServer);
    if (!dock || !several) return dock;
    const info = infos[voiceServer];
    const inVoice = voiceState.myVoice ? (voiceState.voice[voiceState.myVoice.roomId]?.length ?? 0) : 0;
    return { ...dock, server: { name: info?.name ?? hostOf(voiceServer), accent: info?.accent_key ?? null, seats: seatsWords(inVoice) } };
  }, [voiceState, voiceServer, several, infos]);

  const listings = useMemo(
    () =>
      ordered.flatMap((session): ServerListing[] => {
        const state = states[session.baseUrl];
        if (!state) return [];
        const { api, baseUrl } = session;
        const model = listModel(state, now);
        const isQuiet = quiet.has(baseUrl);
        const me = state.me;
        return [
          {
            id: baseUrl,
            name: infos[baseUrl]?.name ?? hostOf(baseUrl),
            accent: infos[baseUrl]?.accent_key ?? null,
            model,
            header: serverHeader(state, model, isQuiet),
            quiet: isQuiet,
            speaking: talkingNow(state),
            onOpenRoom: (room) => openChat(baseUrl, room),
            onOpenDm: (room) => openChat(baseUrl, room),
            onMessage: (user) => void messageWith(api, user),
            onKnock: (user) => knockOn(api, user.id),
            onStartDm: (people) => startDm(api, people),
            saveLine: me ? (line) => said(saveStatus(api, withLine(me.status, line))) : undefined,
          },
        ];
      }),
    [ordered, states, now, quiet, infos],
  );

  // One server: your status and away from the top card, as before.
  const only = ordered.length === 1 ? ordered[0] : undefined;
  const onlyMe = only ? (states[only.baseUrl]?.me ?? null) : null;
  const you = useMemo<YouActions | undefined>(() => {
    if (!only || onlyMe === null) return undefined;
    const { api, baseUrl } = only;
    return {
      awayChoices: awayChoices(loadRecentAway()),
      saveLine: (line) => said(saveStatus(api, withLine(onlyMe.status, line))),
      goAway: async (message) => {
        const problem = await said(saveStatus(api, withAway(onlyMe.status, message)));
        if (problem === null) {
          setAway(baseUrl, message);
          saveRecentAway(rememberAway(loadRecentAway(), message));
        }
        return problem;
      },
      comeBack: async () => {
        const problem = await said(saveStatus(api, withAway(onlyMe.status, null)));
        if (problem === null) setAway(baseUrl, null);
        return problem;
      },
    };
  }, [only, onlyMe]);

  // Several servers: away on the ones you tick, each answering for itself.
  const everywhere = useMemo<AwayEverywhere | undefined>(() => {
    if (!several) return undefined;
    const each = async (servers: string[], message: string | null): Promise<Record<string, string | null>> => {
      const answers = await Promise.all(
        servers.map(async (server): Promise<[string, string | null]> => {
          const session = signedIn.find((one) => one.baseUrl === server);
          const me = states[server]?.me;
          if (!session || !me) return [server, "You're not signed in there any more."];
          const problem = await said(saveStatus(session.api, withAway(me.status, message)));
          if (problem === null) setAway(server, message);
          return [server, problem];
        }),
      );
      return Object.fromEntries(answers);
    };
    return {
      awayChoices: awayChoices(loadRecentAway()),
      goAway: async (message, servers) => {
        const answers = await each(servers, message);
        if (Object.values(answers).some((problem) => problem === null)) saveRecentAway(rememberAway(loadRecentAway(), message));
        return answers;
      },
      comeBack: (servers) => each(servers, null),
    };
  }, [several, signedIn, states]);

  // The foot's standing lines (decision 1): a server that isn't connected
  // after a few seconds, a keyring that can't keep sign-ins, a new version.
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const look = () =>
      void checkForUpdate()
        .then((check) => {
          if (live) setUpdate(check);
        })
        .catch(() => undefined);
    look();
    const timer = window.setInterval(look, UPDATE_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  // When each server stopped being connected. Worked out afresh on every
  // draw from the last one: a second draw of the same moment changes nothing.
  const trouble = useRef<ReadonlyMap<string, number>>(new Map());
  const drawnAt = Date.now();
  trouble.current = troubleSince(trouble.current, new Map(ordered.map((session) => [session.baseUrl, states[session.baseUrl]?.status.kind ?? "offline"])), drawnAt);
  const notes = listNotes(
    ordered.map((session) => ({
      server: session.baseUrl,
      name: infos[session.baseUrl]?.name ?? hostOf(session.baseUrl),
      status: states[session.baseUrl]?.status ?? { kind: "offline" },
      troubleSince: trouble.current.get(session.baseUrl) ?? null,
    })),
    keyringNotice,
    update,
    drawnAt,
  );
  // Nothing else draws the list when a connection's grace runs out, so a
  // timer does, once, at the first one due.
  const [, wake] = useState(0);
  useEffect(() => {
    const due = [...trouble.current.values()].map((since) => since + TROUBLE_GRACE_MS - Date.now()).filter((ms) => ms > 0);
    if (due.length === 0) return;
    const timer = window.setTimeout(() => wake((n) => n + 1), Math.min(...due) + 50);
    return () => window.clearTimeout(timer);
  });

  // Knocks on your door (SPEC §4.9), from every server, even a quiet one's.
  const knocks = useMemo(
    (): KnockCard[] =>
      ordered.flatMap((session) => {
        const state = states[session.baseUrl];
        if (!state) return [];
        return state.knocks.map((one) => ({
          server: session.baseUrl,
          id: one.id,
          at: one.at,
          from: state.users.find((user) => user.id === one.from) ?? null,
          serverName: several ? (infos[session.baseUrl]?.name ?? hostOf(session.baseUrl)) : null,
        }));
      }),
    [ordered, states, several, infos],
  );

  return (
    <>
      {signedIn.map((session) => (
        <ServerLink key={session.baseUrl} session={session} onInfo={onInfo} />
      ))}
      {adding ? (
        <SignInView
          actions={addingActions}
          keyringNotice={keyringNotice}
          adding
          below={voice ? <VoiceDock {...voice} /> : undefined}
          onCancel={() => setAdding(false)}
          onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
        />
      ) : (
        <ListView
        servers={listings}
        voice={voice}
        you={you}
        everywhere={everywhere}
        onQuiet={(server, on) => changePrefs({ ...prefs, quiet: on ? [...prefs.quiet.filter((one) => one !== server), server] : prefs.quiet.filter((one) => one !== server) })}
        onMove={(server, by) => changePrefs({ ...prefs, order: moveServer(ordered.map((one) => one.baseUrl), server, by) })}
        onSettings={() => shell.settings()}
        onMedia={() => shell.tool("media")}
        onSearch={() => shell.tool("search")}
        notices={<KnockCards cards={knocks} onGone={dismissKnock} />}
        notes={<ListNotes notes={notes} onUpdate={() => shell.settings("account")} />}
        onClose={isTauri() ? () => void getCurrentWindow().close() : undefined}
      />
      )}
    </>
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

/** Tell the desktop shell what closing the list does (src-tauri/src/tray.rs). */
function closeToTray(on: boolean): void {
  if (!isTauri()) return;
  void invoke("next_close_to_tray", { on }).catch((error: unknown) => console.error("could not set what closing the list does", error));
}

/** The desktop shell's window commands (src-tauri/src/window.rs); only this window may call them. */
const shell: WindowOpener = {
  chat: (server, roomId, messageId) => {
    if (!isTauri()) return;
    void invoke("next_open_chat", { server, room: roomId, message: messageId ?? null }).catch((error: unknown) =>
      console.error("could not open the chat window", error),
    );
  },
  conversation: (server, roomId, kind, messageId) => {
    if (!isTauri()) return;
    void invoke("next_open_conversation", { server, room: roomId, kind, message: messageId ?? null }).catch((error: unknown) =>
      console.error("could not open the conversation's window", error),
    );
  },
  settings: (section) => {
    if (!isTauri()) return;
    void invoke("next_open_settings", { section: section ?? null }).catch((error: unknown) => console.error("could not open Settings", error));
  },
  tool: (which) => {
    if (!isTauri()) return;
    void invoke("next_open_tool", { which }).catch((error: unknown) => console.error(`could not open ${which}`, error));
  },
};

/** This computer's storage, or none where it's refused. */
function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
    onVolume: (person, volume) => {
      const session = model.people.find((one) => one.user.id === person.user.id)?.session;
      if (session) setVoiceVolume(server, session, volume);
    },
  };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
