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
  markRead,
  onStateChange,
  type SharedLocal,
  sharedLocalOf,
  snapshotOf,
} from "../../lib/gateway";
import { forgetWindow, reportWindow, setPresenceRoom } from "../../lib/watchPresence";
import { answer, type Bus, type Envelope, PROTOCOL } from "./bus";

/** A late window asks for the owner's state. */
export const SNAPSHOT = "next:snapshot";
/** A window whose borrowed token stopped working asks for another. */
export const TOKEN = "next:token";
/** A window asks the owner to do something only the owner may do. */
export const INTENT = "next:intent";
/** The owner tells every window about fields that change without a frame. */
export const SHARED = "next:shared";

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
  /** The conversation this window shows; a room puts you in it, a DM or none does not. */
  | { kind: "room"; server: string; roomId: RoomId | null }
  /** The window is closing: it no longer counts towards being here. */
  | { kind: "closing" };

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
          return;
        case "room":
          if (sessions().has(intent.server)) setPresenceRoom(intent.server, intent.roomId);
          return;
        case "closing":
          forgetWindow(intent.from);
          return;
      }
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
