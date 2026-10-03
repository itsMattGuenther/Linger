import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../../lib/clock";
import {
  connect,
  disconnect,
  dismissKnock,
  type GatewayState,
  leaveVoice,
  loadNotifyRules,
  noteDm,
  retryAllNow,
  saveStatus,
  serverState,
  loadReadMarkers,
  setVoiceDeafened,
  setVoiceMuted,
  setVoiceTalking,
  setVoiceVolume,
  useGateway,
  useServers,
} from "../../../lib/gateway";
import { loadVoicePrefs } from "../../../lib/voice";
import { isTalkKey, talkKeyName } from "../../core/talkKey";
import { forgetNotifications, resetNotifications, setDmAlerts, setQuietServers } from "../../../lib/notify";
import { forgetPreviews } from "../../../lib/previews";
import { type ServerSession, useSessions, type WaitingServer } from "../../../lib/session";
import { dropPresence, setAway, setPresenceLive, setPresenceRoom, startPresence } from "../../../lib/watchPresence";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import { PROTOCOL, tauriBus } from "../../core/bus";
import { isSearchKey, isSettingsKey } from "../../core/keys";
import { listModel } from "../../core/list";
import { inOrder, loadServerPrefs, saveServerPrefs, type ServerPrefs } from "../../core/serverPrefs";
import { moveServer, seatsWords, serverHeader } from "../../core/servers";
import { talkingNow, voiceModel } from "../../core/voice";
import { awayChoices, rememberAway, withAway, withLine } from "../../core/you";
import type { YouActions } from "./YouCard";
import { loadScale } from "../../core/appearance";
import { conversationIn } from "../../core/chat/conversation";
import { loadMode } from "../../core/conversations";
import { leaveDraft } from "../../core/handoff";
import { beside, folding, LIST_MIN, LIST_WIDTH, listWidth, loadSide, paneWidth, saveSide, type Side, unfolding, widestList } from "../../core/side";
import { backTab, isTool, keepOnly, keyOf, loadTabs, NO_TABS, openTab, previewTab, pushTab, same, saveTabs, type SideTab, type Tabs } from "../../core/tabs";
import { type SideHandle, type SideOpen, SidePane } from "../chat/SidePane";
import {
  type Accounts,
  type Intent,
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
  type VoiceControlQuestion,
  type WindowOpener,
} from "../../core/share";
import { loadCloseList } from "../../core/closing";
import { BACKGROUND_GRACE_MS, onPhone, thisDevice, watchBackground, watchNetwork } from "../../core/phone";
import { type SettingsKey, settingsKeys } from "../../core/settings";
import { Settings, type SettingsHolder } from "../settings/SettingsWindow";
import { useBackButton } from "../useBackButton";
import { listNotes, TROUBLE_GRACE_MS, troubleSince, UPDATE_EVERY_MS } from "../../core/notes";
import { checkForUpdate, type UpdateCheck } from "../../../lib/updates";
import { ListNotes } from "./ListNotes";
import { knockOn } from "../../core/knock";
import { readPasted, type SignInActions, signInActions } from "../../core/signin";
import { Button, Spinner, Splitter } from "../../kit";
import { SignInView } from "../signin/SignInView";
import { WindowMessage } from "../WindowMessage";
import { ListView } from "./ListView";
import "./ListWindow.css";
import type { ServerListing } from "./ServerSection";
import type { AwayEverywhere } from "./YouEverywhere";
import { type ArrivalCard, type KnockCard, KnockCards } from "./KnockCards";
import { loadDmAlerts } from "../../core/dmAlerts";
import { arrivalsBetween, CARD_EVERY_MS, cardsHushed, CHIME_EVERY_MS, due, loadArrivalCards, whereAll, type WhereAll } from "../../core/arrivals";
import { loadSoundPrefs, playSound } from "../../../lib/sound";
import { VoiceDock, type VoiceDockProps } from "./VoiceDock";
import { ApiError, PublicApi, TransportError } from "../../../lib/api";
import type { ServerInfo } from "../../../generated/ServerInfo";
import type { User } from "../../../generated/User";

/** How often the server's name is asked for again. It changes about once ever. */
const INFO_REFRESH_MS = 120_000;
/** The tabs beside the list and their order, on this computer (docs/design/architecture.md, "Remembering"). */
const TABS_KEY = "linger.next.tabs";

/**
 * The buddy list window: the owner (docs/design/architecture.md). It restores
 * the sign-ins, connects to each server, watches presence and draws the list:
 * one server's list, or a section per server with several (T-1809).
 */
export function ListWindow() {
  const sessions = useSessions();
  const { addServer } = sessions;
  // Nothing signed in has answered yet, and the person would rather sign in
  // somewhere now than wait (T-907).
  const [signInAnyway, setSignInAnyway] = useState(false);
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

  if (sessions.state.servers.length === 0 && sessions.state.waiting.length > 0 && !signInAnyway) {
    return <NotReached waiting={sessions.state.waiting} onRetry={sessions.retry} onSignIn={() => setSignInAnyway(true)} />;
  }

  if (sessions.state.servers.length === 0) {
    // Signing in lives here until decision 16 says otherwise (parity SIGN-1).
    return (
      <SignInView
        actions={signIn}
        notice={sessions.notice}
        keyringNotice={sessions.keyringNotice}
        onClose={isTauri() && !onPhone() ? () => void getCurrentWindow().close() : undefined}
      />
    );
  }

  const accounts: Accounts = {
    reauthenticate: (server, auth) => sessions.addServer(server, auth),
    signOut: (server) => sessions.signOut(server),
  };
  return (
    <Servers
      signedIn={sessions.state.servers}
      waiting={sessions.state.waiting}
      onRetry={sessions.retry}
      accounts={accounts}
      keyringNotice={sessions.keyringNotice}
    />
  );
}

/**
 * Saved servers, none of which has answered yet (T-907): the sign-ins are
 * kept and Linger keeps trying, so this is a wait, not a sign-in screen. The
 * list opens by itself when one answers.
 */
function NotReached({ waiting, onRetry, onSignIn }: { waiting: readonly WaitingServer[]; onRetry: (server: string) => void; onSignIn: () => void }) {
  const trying = waiting.some((one) => one.why === null);
  const names = waiting.map((one) => hostOf(one.baseUrl));
  const detail = waiting.flatMap((one) => (one.why === null ? [] : [one.why])).join(" ");
  return (
    <WindowMessage>
      <Spinner />
      <span title={detail || undefined}>Can't reach {names.join(" or ")} yet.</span>
      <span className="nx-window-hint">Your sign-in is kept, and Linger keeps trying.</span>
      <span className="nx-window-actions">
        <Button size="sm" disabled={trying} onClick={() => waiting.forEach((one) => onRetry(one.baseUrl))}>
          {trying ? "Trying…" : "Try now"}
        </Button>
        <Button size="sm" variant="quiet" onClick={onSignIn}>
          Sign in to another server
        </Button>
      </span>
    </WindowMessage>
  );
}

/**
 * One server's connection, owned by this window and closed when it goes: no
 * UI of its own. Owning it here is what keeps a StrictMode remount from
 * leaving a socket nobody follows.
 */
function ServerLink({ session, onInfo, paused }: { session: ServerSession; onInfo: (server: string, info: ServerInfo) => void; paused: boolean }) {
  const { api, baseUrl } = session;
  const status = useGateway(baseUrl).status.kind;

  // Paused: the phone app a while in the background, so it shows offline,
  // or with no network. Opened again when it's back (SPEC §4.15, core/phone.ts).
  useEffect(() => {
    if (paused) return;
    void connect(api);
    return () => {
      forgetNotifications(baseUrl);
      forgetPreviews(baseUrl);
      dropPresence(baseUrl);
      void disconnect(baseUrl);
    };
  }, [api, baseUrl, paused]);

  // Opening starts the server's state afresh, so these come again with it.
  useEffect(() => {
    if (paused) return;
    void loadReadMarkers(api);
    void loadNotifyRules(api).catch(() => undefined);
  }, [api, paused]);

  // Around, in no room: a conversation shown beside the list, or in a
  // window of its own, says where you are (core/showing.ts).
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

function Servers({
  signedIn,
  waiting,
  onRetry,
  accounts,
  keyringNotice,
}: {
  signedIn: ServerSession[];
  waiting: readonly WaitingServer[];
  onRetry: (server: string) => void;
  accounts: Accounts;
  keyringNotice: string | null;
}) {
  const states = useServers();
  const now = useNow();
  const [prefs, setPrefs] = useState<ServerPrefs>(() => loadServerPrefs(localStore()));
  // The phone app, a while in the background (SPEC §4.15): its connections close.
  const [backgrounded, setBackgrounded] = useState(false);
  useEffect(() => (onPhone() ? watchBackground(document, BACKGROUND_GRACE_MS, setBackgrounded, () => void retryAllNow()) : undefined), []);
  // And with no network: closed, and opened again the moment there is one.
  const [offline, setOffline] = useState(false);
  useEffect(() => (onPhone() ? watchNetwork(window, setOffline) : undefined), []);
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
  // Conversations beside the list (#337): the tabs, kept here so they
  // outlast folding, and whether the window is unfolded to show them.
  const [tabs, setTabs] = useState<Tabs<SideTab>>(() => loadTabs(stored(TABS_KEY)));
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const [side, setSide] = useState<Side>(() => loadSide(localStore()));
  // The conversation the side unfolds on, for its first draw.
  const [first, setFirst] = useState<SideOpen | null>(null);
  // A brand new DM reaches the store as its own frame, after it was asked
  // for: until it's been seen, its tab waits for it rather than going.
  const unseen = useRef(new Set<string>());
  // The side while it's out, to hand it a conversation or read a draft.
  const handle = useRef<SideHandle | null>(null);
  // Conversations opened in the moment between the side being drawn and it
  // taking them (#355): handed over as soon as it does, message and all.
  const waitingOpens = useRef<SideOpen[]>([]);
  const bind = useCallback((held: SideHandle) => {
    handle.current = held;
    const queued = waitingOpens.current;
    waitingOpens.current = [];
    for (const opening of queued) held.open(opening);
    return () => {
      if (handle.current === held) handle.current = null;
    };
  }, []);
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
    // Conversations open each in a window of its own now: every tab goes to
    // one, the showing one last so it lands on top, its draft with it.
    conversations: (mode) => {
      if (mode !== "windows") return;
      const { open, active } = tabsNow.current;
      const store = localStore();
      for (const tab of [...open.filter((held) => !same(held, active)), ...open.filter((held) => same(held, active))]) {
        if (isTool(tab)) {
          openToolWindow(tab.tool);
          continue;
        }
        const held = handle.current;
        if (store && held) leaveDraft(store, keyOf(tab), held.draftOf(keyOf(tab)), Date.now());
        sharing?.local({ kind: "popout", server: tab.server, roomId: tab.roomId });
      }
      setTabs(NO_TABS);
    },
  };

  // The push-to-talk key the voice bar says to hold. Settings tells this
  // window the moment it's picked (the `voice.pushtotalk` intent, #231).
  const [talkKey, setTalkKey] = useState(() => loadVoicePrefs().pushToTalkKey);

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

  // DM alerts (#291): a banner for every DM and the taskbar pointing at
  // Linger, unless turned off in Settings. Read on every DM, from this
  // computer's storage, so a change in the Settings window counts at once.
  useEffect(() => {
    setDmAlerts(() => loadDmAlerts(localStore()));
    return () => setDmAlerts(null);
  }, []);

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
      conversations: (mode) => listNow.current.conversations?.(mode),
      closeToTray: (on) => closeToTray(on),
      talkKey: (code) => setTalkKey(code),
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

  // ------------------------------------------------------------------
  // Beside the list (#337).

  const unfolded = side.unfolded && tabs.open.length > 0;
  const unfoldedNow = useRef(unfolded);
  unfoldedNow.current = unfolded;
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Side by side, the list at its width or squeezed to leave the
  // conversations their room; too narrow for both, the conversation has it.
  const shown = beside(width, side.list);
  const layout = shown.layout;

  // Folding keeps how wide the conversations were, and unfolding how wide
  // the list was, so each comes back the size it was left.
  const fold = useCallback(() => {
    setFirst(null);
    setSide((held) => {
      if (!held.unfolded) return held;
      const now = beside(window.innerWidth, held.list);
      return { ...held, unfolded: false, pane: now.layout === "beside" ? paneWidth(window.innerWidth - now.list) : held.pane };
    });
  }, []);
  const unfold = useCallback((opening: SideOpen | null) => {
    setFirst(opening);
    setSide((held) => (held.unfolded ? held : { ...held, unfolded: true, list: listWidth(window.innerWidth) }));
  }, []);
  // The last tab closed: back to the list.
  useEffect(() => {
    if (side.unfolded && tabs.open.length === 0) fold();
  }, [side.unfolded, tabs.open.length, fold]);
  useEffect(() => saveSide(localStore(), side), [side]);
  useEffect(() => {
    try {
      window.localStorage.setItem(TABS_KEY, saveTabs(tabs));
    } catch {
      // Storage refused: the tabs just won't come back after a restart.
    }
  }, [tabs]);

  // A conversation that's gone (a room archived, a DM you were taken out
  // of, a server signed out of) loses its tab, once its server has said
  // what exists. One still on its way keeps its tab until it has been seen.
  useEffect(() => {
    const servers = new Set(signedIn.map((session) => session.baseUrl));
    setTabs((held) =>
      keepOnly(held, (tab) => {
        // Media and Search look through every server, as long as there's one.
        if (isTool(tab)) return servers.size > 0;
        if (!servers.has(tab.server)) return false;
        const state = states[tab.server];
        if (state === undefined || state.me === null) return true;
        if (conversationIn(state, tab.roomId) === null) return unseen.current.has(keyOf(tab));
        unseen.current.delete(keyOf(tab));
        return true;
      }),
    );
  }, [states, signedIn]);

  // The window grows to show the conversations and shrinks back to the
  // list, where the desktop lets an app size its windows. Not on the first
  // draw: the window opens the size it was left.
  const sized = useRef<boolean | null>(null);
  useEffect(() => {
    const was = sized.current;
    sized.current = unfolded;
    if (was === null || was === unfolded || !isTauri()) return;
    void (unfolded ? growBeside(side) : shrinkToList(side));
  }, [unfolded]);

  // Show a conversation beside the list: its tab, the side unfolded, and
  // the list window brought forward if it was behind or in the tray.
  const openBeside = useRef<(server: string, roomId: RoomId, messageId?: MessageId, preview?: boolean) => void>(() => undefined);
  openBeside.current = (server, roomId, messageId, preview = false) => {
    if (!apisRef.current.has(server)) return;
    const tab = { server, roomId };
    if (conversationIn(serverState(server), roomId) === null) unseen.current.add(keyOf(tab));
    const opening = { tab, message: messageId ?? null, preview };
    if (handle.current) handle.current.open(opening);
    else if (unfoldedNow.current) waitingOpens.current.push(opening);
    else {
      // On the phone the list is home: anything left from before is gone,
      // and this is the first screen over it.
      setTabs((held) => (onPhone() ? pushTab(NO_TABS, tab) : preview ? previewTab(held, tab) : openTab(held, tab)));
      unfold(opening);
    }
    bringForward();
  };
  // Media or Search beside the list (#337): its tab, and Search's box ready
  // for typing whenever it's asked for again (Ctrl+K).
  const [searchAsk, setSearchAsk] = useState(1);
  const openToolBeside = useRef<(which: "media" | "search") => void>(() => undefined);
  openToolBeside.current = (which) => {
    if (apisRef.current.size === 0) return;
    const tab: SideTab = { tool: which };
    const over = unfoldedNow.current;
    setTabs((held) => (onPhone() ? pushTab(over ? held : NO_TABS, tab) : openTab(held, tab)));
    if (which === "search") setSearchAsk((count) => count + 1);
    if (!unfoldedNow.current) unfold(null);
    bringForward();
  };
  useEffect(() => {
    showBeside = (server, roomId, messageId, preview) => openBeside.current(server, roomId, messageId, preview);
    showToolBeside = (which) => openToolBeside.current(which);
    return () => {
      showBeside = null;
      showToolBeside = null;
    };
  }, []);
  // What the side asks of the owner it's in: the same as any window, without the trip.
  const intendHere = useCallback(async (intent: Intent) => {
    sharing?.local(intent);
  }, []);

  // Settings on the phone: drawn over the list, in the phone's one window
  // (SPEC §4.15). On a computer it's a window of its own (`shell.settings`).
  const [phoneSettings, setPhoneSettings] = useState<{ section?: SettingsKey } | null>(null);
  const phoneSettingsOpen = useRef(false);
  phoneSettingsOpen.current = phoneSettings !== null;
  // On the phone, Back takes the top screen off: a conversation, Media or
  // Search, and the last one off is the list again (SPEC §4.15). Settings,
  // drawn over everything, handles its own.
  const goBack = useCallback(() => setTabs((held) => backTab(held)), []);
  useBackButton(unfolded && phoneSettings === null, goBack);
  const sectionAsked = useRef(new Set<(key: string | null) => void>());
  useEffect(() => {
    if (!onPhone()) return;
    showSettingsHere = (section) => {
      if (phoneSettingsOpen.current) for (const heard of sectionAsked.current) heard(section ?? null);
      else setPhoneSettings({ section: settingsKeys(EVERY_SECTION).find((key) => key === section) });
    };
    return () => {
      showSettingsHere = null;
    };
  }, []);
  // Signing in or out while it's open: it shows what's left.
  const signedInNow = useRef(new Set<(server: string) => void>());
  const signedOutNow = useRef(new Set<(server: string) => void>());
  const wereSignedIn = useRef<readonly string[]>([]);
  useEffect(() => {
    const now = signedIn.map((session) => session.baseUrl);
    const was = wereSignedIn.current;
    wereSignedIn.current = now;
    for (const server of was) if (!now.includes(server)) for (const heard of signedOutNow.current) heard(server);
    for (const server of now) if (!was.includes(server)) for (const heard of signedInNow.current) heard(server);
  }, [signedIn]);
  const phoneHolder = useMemo(
    (): SettingsHolder => ({
      following: {
        // Read when asked: the sign-ins this window holds now.
        get apis() {
          return apisRef.current;
        },
        intend: intendHere,
        onSignedOut: (heard) => {
          signedOutNow.current.add(heard);
          return () => void signedOutNow.current.delete(heard);
        },
        onSignedIn: (heard) => {
          signedInNow.current.add(heard);
          return () => void signedInNow.current.delete(heard);
        },
        stop: () => undefined,
      },
      notify: (question) => sharing?.localNotify(question) ?? Promise.resolve({ problem: "Linger is still starting. Try again in a moment." }),
      password: (question) => sharing?.localPassword(question) ?? Promise.resolve({ problem: "Linger is still starting. Try again in a moment." }),
      onSection: (heard) => {
        sectionAsked.current.add(heard);
        return () => void sectionAsked.current.delete(heard);
      },
      // Your servers' order and Quiet change only in Settings while it covers the list.
      onServerPrefs: () => () => undefined,
      close: () => setPhoneSettings(null),
      closable: true,
      section: phoneSettings?.section,
      phone: true,
    }),
    [intendHere, phoneSettings?.section],
  );

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
  // A voice line's Mute, Deafen and Leave beside the list act here, as the voice bar's do.
  const voiceServerNow = useRef(voiceServer);
  voiceServerNow.current = voiceServer;
  const voiceControl = useCallback((press: VoiceControlQuestion) => {
    const server = voiceServerNow.current;
    if (server === null) return;
    if (press.control === "leave") void leaveVoice(server).catch(() => undefined);
    else if (press.control === "mute") void setVoiceMuted(server, press.on).catch(() => undefined);
    else void setVoiceDeafened(server, press.on).catch(() => undefined);
  }, []);

  // Push-to-talk while the list has focus; a chat window reports its own
  // key presses (core/share.ts, "voice.talk").
  useEffect(() => {
    if (!pushToTalk || voiceServer === null) return;
    const down = (event: KeyboardEvent) => {
      // The chosen key (decision 6), read as it's pressed: Settings may have
      // just changed it, in another window.
      if (isTalkKey(event, loadVoicePrefs().pushToTalkKey) && !event.repeat) void setVoiceTalking(voiceServer, true).catch(() => undefined);
    };
    const release = () => void setVoiceTalking(voiceServer, false).catch(() => undefined);
    const up = (event: KeyboardEvent) => {
      if (isTalkKey(event, loadVoicePrefs().pushToTalkKey)) release();
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

  // A desktop banner clicked (decision 20): the shell hands back where it
  // leads (lib/notify.ts), and the conversation opens there, at the message.
  // Only for a server still signed in.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<unknown>("next:banner", (payload) => {
        const target = bannerTarget(payload);
        if (target && apisRef.current.has(target.server)) openChat(target.server, target.room, target.message);
      })
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
    const dock = voiceDock(voiceState, talkingNow(voiceState), voiceServer, talkKey);
    if (!dock || !several) return dock;
    const info = infos[voiceServer];
    const inVoice = voiceState.myVoice ? (voiceState.voice[voiceState.myVoice.roomId]?.length ?? 0) : 0;
    return { ...dock, server: { name: info?.name ?? hostOf(voiceServer), accent: info?.accent_key ?? null, seats: seatsWords(inVoice) } };
  }, [voiceState, voiceServer, several, infos, talkKey]);

  // The conversation showing beside the list: its row in the list is marked (#351).
  const besideTab = unfolded && tabs.active !== null && !isTool(tabs.active) ? tabs.active : null;
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
            onOpenPerson: (user, dm) => void openPerson(api, user, dm),
            onMessage: (user) => void messageWith(api, user),
            onKnock: (user) => knockOn(api, user.id),
            onStartDm: (people) => startDm(api, people),
            onHost: (section) => shell.settings(section),
            showing: besideTab?.server === baseUrl ? besideTab.roomId : null,
            saveLine: me ? (line) => said(saveStatus(api, withLine(me.status, line))) : undefined,
          },
        ];
      }),
    [ordered, states, now, quiet, infos, besideTab?.server, besideTab?.roomId],
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
    waiting.map((one) => ({ server: one.baseUrl, name: hostOf(one.baseUrl), why: one.why })),
    thisDevice(onPhone()),
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

  // Arrivals (decisions 12 and 13): somebody came into a room. Worked out by
  // comparing where everybody is with where they were, per server, from the
  // server's first word on: a new session (connecting, reconnecting) starts
  // afresh rather than reading as everybody arriving at once. None from a
  // Quiet server, and no cards in quiet hours.
  const [arrivals, setArrivals] = useState<ArrivalCard[]>([]);
  const where = useRef(new Map<string, { session: string; where: WhereAll }>());
  const lastCard = useRef(new Map<string, number>());
  const lastChime = useRef(new Map<string, number>());
  useEffect(() => {
    const now = Date.now();
    const cardsOn = loadArrivalCards(localStore()) && !cardsHushed(loadSoundPrefs(), new Date(now));
    const fresh: ArrivalCard[] = [];
    let chime = false;
    for (const session of ordered) {
      const state = states[session.baseUrl];
      if (!state?.me || state.sessionId === null) continue;
      const before = where.current.get(session.baseUrl);
      const nowWhere = whereAll(state.presence);
      where.current.set(session.baseUrl, { session: state.sessionId, where: nowWhere });
      if (!before || before.session !== state.sessionId || quiet.has(session.baseUrl)) continue;
      // Rooms only: a server from before 0.4.1 still says who is in which DM.
      const rooms = new Map(state.rooms.filter((room) => room.kind === "room").map((room) => [room.id as string, room.name]));
      for (const { userId, roomId } of arrivalsBetween(before.where, nowWhere, state.me.id, new Set(rooms.keys()))) {
        const key = `${session.baseUrl} ${userId}`;
        if (cardsOn && due(lastCard.current.get(key), now, CARD_EVERY_MS)) {
          lastCard.current.set(key, now);
          fresh.push({
            server: session.baseUrl,
            id: `${key} ${now}`,
            at: now,
            who: state.users.find((user) => user.id === userId) ?? null,
            room: rooms.get(roomId) ?? "a room",
            serverName: several ? (infos[session.baseUrl]?.name ?? hostOf(session.baseUrl)) : null,
          });
        }
        if (due(lastChime.current.get(key), now, CHIME_EVERY_MS)) {
          lastChime.current.set(key, now);
          chime = true;
        }
      }
    }
    // At most three at a time: the newest.
    if (fresh.length > 0) setArrivals((held) => [...held, ...fresh].slice(-3));
    // The door chime is off unless somebody turned it on, and quiet hours hold it (lib/sound.ts).
    if (chime) void playSound("door").catch(() => undefined);
  }, [states, ordered, quiet, several, infos]);
  const arrivalGone = useCallback((id: string) => setArrivals((held) => held.filter((card) => card.id !== id)), []);

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

  // Each knock that arrives while the list is open rocks it once (#211). The
  // ones already here when it opened are old news.
  const [rock, setRock] = useState(0);
  const knocksSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = knocks.map((card) => `${card.server} ${card.id}`);
    const seen = knocksSeen.current;
    knocksSeen.current = new Set(keys);
    if (seen !== null && keys.some((key) => !seen.has(key))) setRock((count) => count + 1);
  }, [knocks]);

  // A phone's app is closed the phone's way, never with a button of ours (SPEC §4.15).
  const closeList = isTauri() && !onPhone() ? () => void getCurrentWindow().close() : undefined;
  return (
    <>
      {signedIn.map((session) => (
        <ServerLink key={session.baseUrl} session={session} onInfo={onInfo} paused={backgrounded || offline} />
      ))}
      <div className="nx-app" data-side={unfolded ? layout : "folded"} style={{ "--list-width": `${shown.list}px` } as CSSProperties}>
        <div className="nx-app-list">
          {adding ? (
            <SignInView
              actions={addingActions}
              keyringNotice={keyringNotice}
              adding
              below={voice ? <VoiceDock {...voice} /> : undefined}
              onCancel={() => setAdding(false)}
              onClose={unfolded ? undefined : closeList}
            />
          ) : (
            <ListView
              servers={listings}
              voice={voice}
              you={you}
              onEditProfile={() => shell.settings("profile")}
              everywhere={everywhere}
              onQuiet={(server, on) => changePrefs({ ...prefs, quiet: on ? [...prefs.quiet.filter((one) => one !== server), server] : prefs.quiet.filter((one) => one !== server) })}
              onMove={(server, by) => changePrefs({ ...prefs, order: moveServer(ordered.map((one) => one.baseUrl), server, by) })}
              onSettings={() => shell.settings()}
              onMedia={() => shell.tool("media")}
              onSearch={() => shell.tool("search")}
              notices={<KnockCards cards={knocks} onGone={dismissKnock} arrivals={arrivals} onArrivalGone={arrivalGone} />}
              rock={rock}
              notes={<ListNotes notes={notes} onUpdate={() => shell.settings("account")} onRetry={onRetry} />}
              onUnfold={!onPhone() && !unfolded && tabs.open.length > 0 ? () => unfold(null) : undefined}
              onClose={unfolded ? undefined : closeList}
            />
          )}
        </div>
        {unfolded && layout === "beside" ? (
          // Dragged, or moved with the arrows: the list's width, kept on this
          // computer, and the one folding goes back to. The window stays
          // the size it is; the conversations take what's left.
          <Splitter
            label="Width of your list"
            value={shown.list}
            min={LIST_MIN}
            max={widestList(width)}
            reset={LIST_WIDTH}
            onChange={(list) => setSide((held) => ({ ...held, list }))}
          />
        ) : null}
        {unfolded ? (
          <SidePane
            apis={apisRef.current}
            intend={intendHere}
            tabs={tabs}
            setTabs={setTabs}
            first={first}
            bind={bind}
            show={(server, roomId, messageId) => openChat(server, roomId, messageId)}
            searchAsk={searchAsk}
            onPopOutTool={openToolWindow}
            voiceControl={voiceControl}
            onFold={fold}
            onClose={closeList}
            onBack={onPhone() ? goBack : undefined}
          />
        ) : null}
      </div>
      {phoneSettings ? (
        <div className="nx-phone-over">
          <Settings holder={phoneHolder} />
        </div>
      ) : null}
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
 * A person clicked in the list (#351): your DM with them, beside the list as
 * a preview the next person takes over until it's kept, or in a window of
 * its own when everything opens in one. Made first if you've never talked.
 */
async function openPerson(api: ServerSession["api"], user: User, dm: RoomId | null): Promise<void> {
  if (dm !== null) {
    openChat(api.baseUrl, dm, undefined, true);
    return;
  }
  try {
    const made = await api.openDm([user.id]);
    noteDm(api.baseUrl, made);
    openChat(api.baseUrl, made.id, undefined, true);
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
  side: (server, roomId, messageId, preview) => showBeside?.(server, roomId, messageId, preview),
  conversation: (server, roomId, kind, messageId) => {
    if (!isTauri()) return;
    void invoke("next_open_conversation", { server, room: roomId, kind, message: messageId ?? null }).catch((error: unknown) =>
      console.error("could not open the conversation's window", error),
    );
  },
  settings: (section) => {
    // The phone's one window draws Settings over the list (SPEC §4.15).
    if (showSettingsHere) {
      showSettingsHere(section);
      return;
    }
    if (!isTauri()) return;
    void invoke("next_open_settings", { section: section ?? null }).catch((error: unknown) => console.error("could not open Settings", error));
  },
  // Media and Search open where conversations do: beside the list, or in
  // a window of their own when everything opens in its own (#337).
  tool: (which) => {
    if (showToolBeside && loadMode(localStore()) !== "windows") showToolBeside(which);
    else openToolWindow(which);
  },
};

/** Media or Search in a window of its own (decision 15): popped out, or every conversation in its own window. */
function openToolWindow(which: "media" | "search"): void {
  if (!isTauri()) return;
  void invoke("next_open_tool", { which }).catch((error: unknown) => console.error(`could not open ${which}`, error));
}

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
/** Beside the list, once the list is drawn (`openBeside` in `Servers`). */
let showBeside: ((server: string, roomId: RoomId, messageId?: MessageId, preview?: boolean) => void) | null = null;
/** Media or Search beside the list, once it's drawn. */
let showToolBeside: ((which: "media" | "search") => void) | null = null;
/** Settings over the list, on the phone only, once the list is drawn. */
let showSettingsHere: ((section?: string) => void) | null = null;
/** A scope with every section in it, to check a section asked for against. */
const EVERY_SECTION = { hosting: "any", severalServers: true, windows: true };

/**
 * Show a conversation: in its own window if it was popped out into one,
 * otherwise where conversations open (core/share.ts, `open`): beside the
 * list, or each in a window of its own.
 */
function openChat(server: string, room: RoomId, messageId?: MessageId, preview = false): void {
  if (sharing) sharing.open(server, room, messageId, { preview });
  else showBeside?.(server, room, messageId, preview);
}

/** Something this computer kept, or null where storage is refused. */
function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Bring the list window forward for a conversation opened from elsewhere (a
 * banner, a window of its own): out of the tray, unminimized, focused. Not
 * when it has the focus already: some desktops move the pointer to a window
 * an app focuses (dont-fight-the-os, #226).
 */
function bringForward(): void {
  if (!isTauri() || document.hasFocus()) return;
  const current = getCurrentWindow();
  void current
    .show()
    .then(() => current.unminimize())
    .then(() => current.setFocus())
    .catch(() => undefined);
}

/**
 * Unfolding: the window grows to the right by the conversations' width,
 * leftwards where its screen ends (core/side.ts). A maximized window, or one
 * the desktop sizes itself (a tiling desktop), keeps its size, and the
 * conversations fit what they get.
 */
async function growBeside(side: Side): Promise<void> {
  try {
    const current = getCurrentWindow();
    if (await current.isMaximized()) return;
    const factor = await current.scaleFactor();
    const inner = (await current.innerSize()).toLogical(factor);
    const at = (await current.outerPosition()).toLogical(factor);
    const monitor = await currentMonitor();
    const screen = monitor ? { x: monitor.position.x / monitor.scaleFactor, width: monitor.size.width / monitor.scaleFactor } : null;
    const target = unfolding({ x: at.x, width: inner.width }, screen, side, loadScale() / 100);
    if (!target) return;
    if (target.x !== null) await current.setPosition(new LogicalPosition(target.x, at.y));
    await current.setSize(new LogicalSize(target.width, inner.height));
  } catch {
    // A desktop that won't move or size the window: it stays as it is.
  }
}

/** Folding: back to the list's width, where the desktop lets it. */
async function shrinkToList(side: Side): Promise<void> {
  try {
    const current = getCurrentWindow();
    if (await current.isMaximized()) return;
    const factor = await current.scaleFactor();
    const inner = (await current.innerSize()).toLogical(factor);
    const width = folding(side, loadScale() / 100);
    if (inner.width > width) await current.setSize(new LogicalSize(width, inner.height));
  } catch {
    // A desktop that won't size the window: the list fills it.
  }
}

/** What a clicked banner says it leads to, if it says it properly (`src-tauri/src/notifications.rs`). */
function bannerTarget(payload: unknown): { server: string; room: RoomId; message: MessageId } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const server: unknown = Reflect.get(payload, "server");
  const room: unknown = Reflect.get(payload, "room");
  const message: unknown = Reflect.get(payload, "message");
  if (typeof server !== "string" || typeof room !== "string" || typeof message !== "string") return null;
  return { server, room, message };
}

/**
 * The voice bar: what it shows comes from the store (core/voice.ts); its
 * controls act here, in the owner, which keeps the voice seat.
 */
function voiceDock(state: GatewayState, speaking: ReadonlySet<string>, server: string, talkKey: string): VoiceDockProps | undefined {
  const model = voiceModel(state, speaking, talkKeyName(talkKey));
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
