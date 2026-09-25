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
import type { AuthedApi, Lent } from "../../lib/api";
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
  sharedLocalOf,
  snapshotOf,
} from "../../lib/gateway";
import { loadVoicePrefs } from "../../lib/voice";
import { forgetWindow, reportWindow, setPresenceRoom } from "../../lib/watchPresence";
import { answer, type Bus, type Envelope, OWNER, PROTOCOL } from "./bus";
import { close, focus, NOTHING_SHOWN, presenceRoom, show, type Showing } from "./showing";

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
  | { kind: "voice.talk"; down: boolean };

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
export async function shareAsOwner(bus: Bus, sessions: () => ReadonlyMap<string, AuthedApi>): Promise<() => void> {
  const lend = async (api: AuthedApi, stale?: string): Promise<Lent> => {
    const current = await api.accessToken();
    if (stale === undefined || current.token !== stale) return current;
    return api.accessToken(true);
  };

  // What each window shows, so presence puts you in the room of the window
  // you were last in (core/showing.ts), and nowhere once they have all gone.
  let showing: Showing = NOTHING_SHOWN;
  let placed: string | null = null;
  const place = () => {
    const room = presenceRoom(showing, new Set(sessions().keys()));
    const key = room ? `${room.server} ${room.roomId}` : "";
    if (key === placed) return;
    placed = key;
    if (room) setPresenceRoom(room.server, room.roomId);
    else for (const server of sessions().keys()) setPresenceRoom(server, null);
  };
  const gone = (label: string) => {
    forgetWindow(label);
    showing = close(showing, label);
    place();
  };

  const stops = await Promise.all([
    answer<Record<string, never>, SnapshotAnswer>(bus, SNAPSHOT, async () => ({
      servers: await Promise.all(
        [...sessions()].map(async ([server, api]): Promise<ServerShare> => {
          // Read the state and its position together, before any await, so
          // they describe the same moment.
          const { state, position } = snapshotOf(server);
          return { server, state, position, lent: await lend(api) };
        }),
      ),
    })),
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
          if (intent.focused) {
            showing = focus(showing, intent.from, Date.now());
            place();
          }
          return;
        case "room":
          if (!sessions().has(intent.server)) return;
          showing = show(showing, intent.from, intent.server, intent.roomId);
          place();
          return;
        case "closing":
          gone(intent.from);
          return;
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
              if (mine?.pushToTalk) void setVoiceMuted(server, !intent.down).catch(() => undefined);
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

  return () => {
    stopWatching();
    for (const stop of stops) stop();
  };
}
