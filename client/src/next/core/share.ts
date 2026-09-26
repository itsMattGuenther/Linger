/**
 * The owner window's half of sharing one connection between windows
 * (docs/design/architecture.md, "How windows share state", "Tokens across
 * windows", "Viewer → owner: intents").
 *
 * The owner already connects, folds every frame and runs the side effects,
 * exactly as today's client does. This adds what the other windows need from
 * it: a snapshot to start from, access tokens to borrow, the fields that
 * change without a frame, and someone to carry out what only the owner may do.
 */
import type { MessageId } from "../../generated/MessageId";
import type { RoomId } from "../../generated/RoomId";
import type { AuthResponse } from "../../generated/AuthResponse";
import type { NotifyRule } from "../../generated/NotifyRule";
import { ApiError, type AuthedApi, type Lent, PublicApi, TransportError } from "../../lib/api";
import { passwordRequest } from "../../lib/account";
import type { Position } from "../../lib/catchup";
import {
  type GatewayState,
  joinVoice,
  leaveVoice,
  markRead,
  onStateChange,
  serverState,
  setVoiceDeafened,
  setVoiceMuted,
  type SharedLocal,
  setNotifyRule,
  sharedLocalOf,
  snapshotOf,
} from "../../lib/gateway";
import { loadVoicePrefs } from "../../lib/voice";
import { setViewing } from "../../lib/notify";
import { forgetWindow, reportWindow, setAway, setPresenceRoom } from "../../lib/watchPresence";
import { answer, type Bus, type Envelope, OWNER, PROTOCOL } from "./bus";
import { type ConversationsMode, isMode, loadMode, type ModeStore, saveMode } from "./conversations";
import { prefsFrom, type ServerPrefs } from "./serverPrefs";
import { blur, close, focus, NOTHING_SHOWN, presenceRoom, show, type Showing, viewing } from "./showing";

/** The chat window's label, in tabs mode (src-tauri/src/window.rs). */
const CHAT = "chat";

/**
 * How long a window that's opening waits for a server's token to be renewed
 * before it's lent the one held. Well inside the 5 seconds it waits for the
 * whole answer (bus.ts `ask`).
 */
export const LEND_WAIT_MS = 1_500;

/** A late window asks for the owner's state. */
export const SNAPSHOT = "next:snapshot";
/** A window whose borrowed token stopped working asks for another. */
export const TOKEN = "next:token";
/** A window asks the owner to do something only the owner may do. */
export const INTENT = "next:intent";
/** The owner tells every window about fields that change without a frame. */
export const SHARED = "next:shared";
/** The desktop shell tells the owner a window has gone, however it went (src-tauri/src/window.rs). */
export const CLOSED = "next:closed";
/** The owner tells every window how conversations open now (core/conversations.ts). */
export const MODE = "next:mode";
/** The tabs window, now listening, asks what it was sent to open before it was. */
export const OPENS = "next:opens";
/** A server was signed out of, however it happened: every window lets it go. */
export const SIGNED_OUT = "next:signedout";
/** A server was signed in to (added, or back after a sign-out): every open window takes it up. */
export const SIGNED_IN = "next:signedin";
/** Your servers' order and Quiet changed, wherever it was changed: Settings shows it. */
export const SERVER_PREFS = "next:serverprefs";

export interface ServerPrefsMessage {
  v: number;
  prefs: ServerPrefs;
}
/** Settings asks the owner to turn a notification rule on or off (the owner keeps them). */
export const NOTIFY = "next:notify";
/** Settings asks the owner to change your password and sign back in with the new one. */
export const PASSWORD = "next:password";

export interface NotifyQuestion {
  server: string;
  rule: NotifyRule;
  on: boolean;
}

export interface PasswordQuestion {
  server: string;
  current: string;
  next: string;
}

/** How a request to the owner went: the problem in words, or null. */
export interface Outcome {
  problem: string | null;
}

export interface SignedOutMessage {
  v: number;
  server: string;
}

export type SignedInMessage = SignedOutMessage;

/** The servers in `before` that aren't in `after`: signed out of since (and, turned round, signed in to). */
export function leftOut(before: readonly string[], after: readonly string[]): string[] {
  const still = new Set(after);
  return before.filter((server) => !still.has(server));
}

/** A window's question for the owner's state: every server, or only one it has just heard was signed in to. */
export interface SnapshotQuestion {
  only?: string;
}

/** How long the owner keeps a conversation sent to a tabs window that isn't listening yet. */
export const MISSED_KEEP_MS = 10_000;

/** What the tabs window was sent to open before it was listening, oldest first. */
export interface OpensAnswer {
  opens: { server: string; roomId: RoomId; messageId?: MessageId }[];
}

export interface ModeMessage {
  v: number;
  mode: ConversationsMode;
}

export interface ServerShare {
  server: string;
  /** The owner's copy, without loaded history. */
  state: GatewayState;
  /** Where that copy stands, for catching up (`lib/catchup.ts`). */
  position: Position;
  /** An access token to borrow; never the refresh token. */
  lent: Lent;
}

export interface SnapshotAnswer {
  servers: ServerShare[];
}

export interface TokenQuestion {
  server: string;
  /** The token that stopped working, so an owner that already renewed can simply lend the newer one. */
  stale: string;
}

/** What a window may ask the owner to do. Kept small on purpose. */
export type Intent =
  /** Mark a conversation read up to a message (the owner keeps read positions). */
  | { kind: "read"; server: string; roomId: RoomId; messageId: MessageId }
  /** The window gained or lost focus, or the person typed or moved in it (presence). */
  | { kind: "window"; focused: boolean; input: boolean }
  /** The conversation this window shows (a room or DM; null for none), as today's client passes it. */
  | { kind: "room"; server: string; roomId: RoomId | null }
  /** The window is closing: it no longer counts towards being here. */
  | { kind: "closing" }
  /** Join voice in a room, or move it there: you are in voice in one room at a time (SPEC §4.14). */
  | { kind: "voice.join"; server: string; roomId: RoomId }
  | { kind: "voice.leave" }
  | { kind: "voice.mute"; muted: boolean }
  | { kind: "voice.deafen"; deafened: boolean }
  /** The push-to-talk key went down or up in this window. */
  | { kind: "voice.talk"; down: boolean }
  /** Pop a tab out into a window of its own. */
  | { kind: "popout"; server: string; roomId: RoomId }
  /** A conversation in its own window goes back into the chat window's tabs. */
  | { kind: "tabs"; server: string; roomId: RoomId }
  /** Show a conversation where conversations open (tabs or its own window), as the list would, at a message if one is named. */
  | { kind: "open"; server: string; roomId: RoomId; conversation: "room" | "dm"; messageId?: MessageId }
  /** Open Search or Media (their own windows, decision 15). */
  | { kind: "tool"; which: "search" | "media" }
  /** Settings changed how conversations open: every window rearranges itself. */
  | { kind: "conversations"; mode: ConversationsMode }
  /** Open Settings (Ctrl+, in any window), on a section if one is named. */
  | { kind: "settings"; section?: string }
  /** Sign out of a server on this computer. */
  | { kind: "signout"; server: string }
  /** You went away (with the message) or came back (null), from Settings: presence is the owner's. */
  | { kind: "away"; server: string; message: string | null }
  /** Add a server, from Settings: the list window shows its sign-in. */
  | { kind: "addserver" }
  /** Settings changed your servers' order or which are Quiet (Settings → Servers). */
  | { kind: "serverprefs"; order: string[]; quiet: string[] };

/** The list window's own choices another window may ask it to make. */
export interface ListControls {
  /** Show the sign-in for another server, keeping the rest connected. */
  addServer(): void;
  /** Your servers' order and which are Quiet, as Settings last left them. */
  setPrefs(prefs: ServerPrefs): void;
}

/**
 * How the owner opens windows: the desktop shell's commands in the app
 * (src-tauri/src/window.rs; only the owner may call them), fakes in tests.
 */
export interface WindowOpener {
  /** The chat window, adding a tab for this conversation or showing it, at a message if one is named. */
  chat(server: string, roomId: RoomId, messageId?: MessageId): void;
  /** This conversation in a window of its own, or that window brought forward, at a message if one is named. */
  conversation(server: string, roomId: RoomId, kind: "room" | "dm", messageId?: MessageId): void;
  /** The Settings window, on a section if one is named. */
  settings(section?: string): void;
  /** Search's or Media's window, or that window brought forward (decision 15). */
  tool(which: "search" | "media"): void;
}

/** The sign-ins, which only the owner holds (lib/session.ts). */
export interface Accounts {
  /** A fresh sign-in for a server, after a password change ended the old one. */
  reauthenticate(server: string, auth: AuthResponse): Promise<void>;
  signOut(server: string): Promise<void>;
}

/** What the owner can do once it is sharing. */
export interface Sharing {
  stop(): void;
  /**
   * Show a conversation: in the window it was popped out into, if it has one,
   * otherwise in the chat window's tabs.
   */
  open(server: string, roomId: RoomId, messageId?: MessageId): void;
  /**
   * The sign-ins changed (a server added, or signed back into after a
   * password change, which starts its presence afresh): put you back in the
   * room you're in.
   */
  signInsChanged(): void;
}

/**
 * Where your voice seat is, if anywhere: at most one server has one. Voice
 * controls act on that server.
 */
function voiceServer(servers: Iterable<string>): string | null {
  for (const server of servers) if (serverState(server).myVoice !== null) return server;
  return null;
}

export interface SharedMessage {
  v: number;
  server: string;
  shared: SharedLocal;
}

/**
 * Start sharing. `sessions` is read on every question, so servers signed into
 * or out of later are handled without restarting.
 */
export interface ShareOptions {
  /** How windows open. Without one, nothing opens (tests that don't care). */
  opener?: WindowOpener;
  /** Where this computer keeps how conversations open. */
  store?: ModeStore | null;
  /** The sign-ins, for a password change and signing out. */
  accounts?: Accounts;
  /** Adding a server and your servers' order, which the list window shows. */
  list?: ListControls;
}

/** An error from a request, as a sentence for the person. */
function inWords(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof TransportError ? error.message : fallback;
}

export async function shareAsOwner(
  bus: Bus,
  sessions: () => ReadonlyMap<string, AuthedApi>,
  { opener, store = null, accounts, list }: ShareOptions = {},
): Promise<Sharing> {
  const lend = async (api: AuthedApi, stale?: string): Promise<Lent> => {
    const current = await api.accessToken();
    if (stale === undefined || current.token !== stale) return current;
    return api.accessToken(true);
  };
  // A window that's opening gets each server's token on its own: renewed if
  // it's about to run out, but a server that isn't answering never holds up
  // the others, or the window. What it's lent then may be out of date, and it
  // asks for a new one (TOKEN) once it finds out.
  const lendOnOpen = async (api: AuthedApi): Promise<Lent> => {
    const held = api.heldToken();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<Lent>((settle) => {
      timer = setTimeout(() => settle(held), LEND_WAIT_MS);
    });
    try {
      return await Promise.race([lend(api).catch(() => held), waited]);
    } finally {
      clearTimeout(timer);
    }
  };

  // What each window shows, so presence puts you in the room of the window
  // you were last in (core/showing.ts), and nowhere once they have all gone.
  // Presence skips a room it already holds (lib/watchPresence.ts), so this
  // keeps no copy of its own: a copy went stale when a server's presence was
  // started afresh (signing back in after a password change).
  let showing: Showing = NOTHING_SHOWN;
  const place = () => {
    const room = presenceRoom(showing, new Set(sessions().keys()));
    if (room) setPresenceRoom(room.server, room.roomId);
    else for (const server of sessions().keys()) setPresenceRoom(server, null);
  };
  // The conversation you're looking at right now, so a message arriving in
  // it doesn't chime or pop a banner (lib/notify.ts). Only the owner notifies.
  let looked: string | null = null;
  const look = () => {
    const now = viewing(showing, new Set(sessions().keys()));
    const key = now ? `${now.server} ${now.roomId}` : "";
    if (key === looked) return;
    looked = key;
    setViewing(now);
  };
  // The shell hands an open tabs window each conversation as an event
  // (window.rs, `next_open_chat`), and a window still catching up isn't
  // listening yet: two rooms clicked quickly, or several windows going back
  // into the tabs at once, would lose all but the first. So every open is
  // also kept here until the tabs window says it's listening (OPENS), and it
  // is handed what it missed.
  // Kept only a little while: a tabs window that never came up shouldn't
  // open old rooms whenever the next one does.
  let tabsListening = false;
  let missed: (OpensAnswer["opens"][number] & { at: number })[] = [];
  const toTabs = (server: string, roomId: RoomId, messageId?: MessageId) => {
    if (!tabsListening) missed.push({ server, roomId, messageId, at: Date.now() });
    opener?.chat(server, roomId, messageId);
  };

  // The windows holding the push-to-talk key down right now. A window that
  // closes with it held (Ctrl+W, with Ctrl being the key) never says it let
  // go, so its going closes the microphone.
  const holdingTalk = new Set<string>();
  const letGoOfTalk = () => {
    const server = voiceServer(sessions().keys());
    if (server !== null && serverState(server).myVoice?.pushToTalk) void setVoiceMuted(server, true).catch(() => undefined);
  };

  const gone = (label: string) => {
    if (label === CHAT) {
      tabsListening = false;
      missed = [];
    }
    if (holdingTalk.delete(label)) letGoOfTalk();
    forgetWindow(label);
    showing = close(showing, label);
    place();
    look();
  };

  // A conversation's own window, if one shows it: any window but the tabs.
  const ownWindow = (server: string, roomId: RoomId): boolean =>
    [...showing].some(([label, shown]) => label !== CHAT && shown.server === server && shown.roomId === roomId);
  const kindOf = (server: string, roomId: RoomId): "room" | "dm" | null => {
    const state = serverState(server);
    if (state.dms.some((dm) => dm.id === roomId)) return "dm";
    return state.rooms.some((room) => room.id === roomId) ? "room" : null;
  };
  const inOwnWindow = (server: string, roomId: RoomId, messageId?: MessageId, known?: "room" | "dm") => {
    const kind = known ?? kindOf(server, roomId);
    if (kind !== null) opener?.conversation(server, roomId, kind, messageId);
  };
  const open = (server: string, roomId: RoomId, messageId?: MessageId, known?: "room" | "dm") => {
    if (loadMode(store) === "windows" || ownWindow(server, roomId)) inOwnWindow(server, roomId, messageId, known);
    else toTabs(server, roomId, messageId);
  };

  const stops = await Promise.all([
    answer<SnapshotQuestion, SnapshotAnswer>(bus, SNAPSHOT, async ({ from, only }) => {
      // The tabs window starting (or starting again) isn't listening for opens
      // until it says so; one catching up on a single new server still is.
      if (from === CHAT && only === undefined) tabsListening = false;
      const wanted = [...sessions()].filter(([server]) => only === undefined || server === only);
      return {
        servers: await Promise.all(
          wanted.map(async ([server, api]): Promise<ServerShare> => {
            // Read the state and its position together, before any await, so
            // they describe the same moment.
            const { state, position } = snapshotOf(server);
            return { server, state, position, lent: await lendOnOpen(api) };
          }),
        ),
      };
    }),
    answer<NotifyQuestion, Outcome>(bus, NOTIFY, async ({ server, rule, on }) => {
      const api = sessions().get(server);
      if (!api) return { problem: "You're not signed in to that server any more." };
      try {
        await setNotifyRule(api, rule, on);
        return { problem: null };
      } catch (error) {
        return { problem: inWords(error, "Couldn't reach the server.") };
      }
    }),
    // A password change ends every other sign-in for the account (the server
    // can't tell who else had the old one), so the owner signs straight back
    // in with the new password rather than leave every window to be signed
    // out when its token runs out. The passwords are never kept or logged.
    answer<PasswordQuestion, Outcome>(bus, PASSWORD, async ({ server, current, next }) => {
      const api = sessions().get(server);
      const username = serverState(server).me?.username;
      if (!api || username === undefined) return { problem: "You're not signed in to that server any more." };
      try {
        await api.changePassword(passwordRequest(current, next));
      } catch (error) {
        return { problem: inWords(error, "Couldn't change your password.") };
      }
      try {
        const auth = await new PublicApi(server).login({ username, password: next });
        await accounts?.reauthenticate(server, auth);
        return { problem: null };
      } catch {
        return { problem: "Password changed. Sign out and back in with the new one." };
      }
    }),
    answer<Record<string, never>, OpensAnswer>(bus, OPENS, async ({ from }) => {
      if (from !== CHAT) return { opens: [] };
      tabsListening = true;
      const fresh = Date.now() - MISSED_KEEP_MS;
      const opens = missed.filter((open) => open.at >= fresh).map(({ server, roomId, messageId }) => ({ server, roomId, messageId }));
      missed = [];
      return { opens };
    }),
    answer<TokenQuestion, Lent>(bus, TOKEN, async ({ server, stale }) => {
      const api = sessions().get(server);
      if (!api) throw new Error(`not signed in to ${server}`);
      return lend(api, stale);
    }),
    bus.listen<Intent & Envelope>(INTENT, (intent) => {
      if (intent.v !== PROTOCOL) return;
      switch (intent.kind) {
        case "read": {
          const api = sessions().get(intent.server);
          if (api) markRead(api, intent.roomId, intent.messageId);
          return;
        }
        case "window":
          reportWindow(intent.from, { focused: intent.focused, input: intent.input });
          showing = intent.focused ? focus(showing, intent.from, Date.now()) : blur(showing, intent.from);
          place();
          look();
          return;
        case "room":
          if (!sessions().has(intent.server)) return;
          showing = show(showing, intent.from, intent.server, intent.roomId);
          place();
          look();
          return;
        case "closing":
          gone(intent.from);
          return;
        case "popout":
          if (sessions().has(intent.server)) inOwnWindow(intent.server, intent.roomId);
          return;
        case "tabs":
          if (sessions().has(intent.server)) toTabs(intent.server, intent.roomId);
          return;
        case "open": {
          // A DM made a moment ago may not have reached this window yet, so
          // the asking window says which kind it is. A message named (a
          // search hit, a media tile) is where the conversation opens.
          if (!sessions().has(intent.server)) return;
          const messageId = typeof intent.messageId === "string" ? intent.messageId : undefined;
          open(intent.server, intent.roomId, messageId, intent.conversation === "dm" ? "dm" : "room");
          return;
        }
        case "settings":
          opener?.settings(typeof intent.section === "string" ? intent.section : undefined);
          return;
        case "tool":
          if (intent.which === "search" || intent.which === "media") opener?.tool(intent.which);
          return;
        case "away":
          if (sessions().has(intent.server)) setAway(intent.server, typeof intent.message === "string" ? intent.message : null);
          return;
        case "signout":
          if (sessions().has(intent.server)) void accounts?.signOut(intent.server).catch(() => undefined);
          return;
        case "addserver":
          list?.addServer();
          return;
        case "serverprefs":
          list?.setPrefs(prefsFrom(intent));
          return;
        case "conversations": {
          if (!isMode(intent.mode)) return;
          saveMode(store, intent.mode);
          const message: ModeMessage = { v: PROTOCOL, mode: intent.mode };
          void bus.broadcast(MODE, message);
          return;
        }
        case "voice.join": {
          const api = sessions().get(intent.server);
          if (!api) return;
          // The same devices and push-to-talk choice today's client joins
          // with. A device that can't be opened leaves you out of voice, and
          // the list window's voice bar says so.
          const prefs = loadVoicePrefs();
          void joinVoice(api, intent.roomId, prefs.devices, prefs.pushToTalk).catch(() => undefined);
          return;
        }
        default: {
          const server = voiceServer(sessions().keys());
          if (server === null) return;
          const mine = serverState(server).myVoice;
          switch (intent.kind) {
            case "voice.leave":
              void leaveVoice(server).catch(() => undefined);
              return;
            case "voice.mute":
              void setVoiceMuted(server, intent.muted).catch(() => undefined);
              return;
            case "voice.deafen":
              void setVoiceDeafened(server, intent.deafened).catch(() => undefined);
              return;
            case "voice.talk":
              // Push-to-talk only means something when it is on: the key
              // opens the microphone while held and closes it on release.
              if (intent.down === true) holdingTalk.add(intent.from);
              else holdingTalk.delete(intent.from);
              if (mine?.pushToTalk) void setVoiceMuted(server, intent.down !== true).catch(() => undefined);
              return;
          }
        }
      }
    }),
    // A window that crashed or was closed by the desktop never said "closing".
    bus.listen<string>(CLOSED, (label) => {
      if (label !== OWNER) gone(label);
    }),
  ]);

  // The fields that change without a frame are the owner's to keep; every
  // other window is told the new value whenever one changes.
  const sent = new Map<string, string>();
  const stopWatching = onStateChange(() => {
    for (const server of sessions().keys()) {
      const shared = sharedLocalOf(server);
      const key = JSON.stringify(shared);
      if (sent.get(server) === key) continue;
      sent.set(server, key);
      const message: SharedMessage = { v: PROTOCOL, server, shared };
      void bus.broadcast(SHARED, message);
    }
  });

  return {
    stop() {
      stopWatching();
      for (const stop of stops) stop();
    },
    open,
    signInsChanged: place,
  };
}
