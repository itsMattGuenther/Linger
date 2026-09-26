/**
 * A viewer window's half of sharing one connection
 * (docs/design/architecture.md, "How windows share state").
 *
 * The core delivers every gateway frame to every window. A viewer starts
 * buffering those at once, asks the owner for a snapshot, adopts it, applies
 * only the buffered frames the snapshot lacks (`lib/catchup.ts`), and from
 * then on applies frames as they come: the same pure fold the owner runs,
 * with none of the owner's side effects. Tokens are borrowed from the owner.
 */
import type { ServerFrame } from "../../generated/ServerFrame";
import { AuthedApi, BorrowedTokens, type Lent } from "../../lib/api";
import { admit, catchUp } from "../../lib/catchup";
import {
  adopt,
  adoptShared,
  applyFollowed,
  follow,
  followStatus,
  type GatewayStatus,
  positionOf,
  unfollow,
} from "../../lib/gateway";
import { ask, type Bus, OWNER, PROTOCOL } from "./bus";
import {
  INTENT,
  type Intent,
  SHARED,
  type SharedMessage,
  SIGNED_IN,
  SIGNED_OUT,
  type SignedInMessage,
  type SignedOutMessage,
  SNAPSHOT,
  type SnapshotAnswer,
  type SnapshotQuestion,
  TOKEN,
  type TokenQuestion,
} from "./share";

export interface Following {
  /** One borrowed sign-in per server the owner is connected to; a server signed out of leaves it. */
  apis: ReadonlyMap<string, AuthedApi>;
  /** Ask the owner to do something only it may do. */
  intend(intent: Intent): Promise<void>;
  /** Hear when a server is signed out of, after this window has let it go. */
  onSignedOut(heard: (server: string) => void): () => void;
  /** Hear when a server is signed in to, once this window has caught up with it. */
  onSignedIn(heard: (server: string) => void): () => void;
  stop(): void;
}

/**
 * Catch this window up with the owner and keep it up to date. Rejects if the
 * owner doesn't answer: a viewer with no owner has nothing to show.
 */
export async function followOwner(bus: Bus): Promise<Following> {
  // Buffer from the very start, before asking, so nothing sent between the
  // owner's answer and its arrival here is lost (lib/catchup.ts).
  const buffers = new Map<string, ServerFrame[]>();
  const live = new Set<string>();
  // Once the owner has answered, a frame for a server it didn't share has no
  // copy to go into, so it is dropped rather than buffered forever.
  let settled = false;

  // A server signed out of is let go at once: its borrowed sign-in, its
  // state, its frames. One signed out of while the owner's answer was on its
  // way is never taken up.
  const apis = new Map<string, AuthedApi>();
  const sharedMeanwhile = new Map<string, SharedMessage["shared"]>();
  const signedOut = new Set<string>();
  const hearing = new Set<(server: string) => void>();
  const letGo = (server: string) => {
    signedOut.add(server);
    catching.delete(server);
    buffers.delete(server);
    if (!apis.has(server)) return;
    apis.delete(server);
    live.delete(server);
    unfollow(server);
    for (const heard of hearing) heard(server);
  };

  // A server signed in to after this window opened is caught up on its own,
  // the same way: buffer its frames from now, ask for the owner's copy, and
  // replay what the copy lacks. Until then its frames wait here.
  const catching = new Set<string>();
  const welcomed = new Set<(server: string) => void>();
  let opened: Promise<void> = Promise.resolve();
  const take = (share: SnapshotAnswer["servers"][number]) => {
    const server = share.server;
    const tokens = new BorrowedTokens(share.lent, (stale) => {
      const question: TokenQuestion = { server, stale };
      return ask<Lent>(bus, OWNER, TOKEN, question);
    });
    const api = new AuthedApi(server, tokens);
    apis.set(server, api);
    follow(api);
    adopt(server, { state: share.state, position: share.position });
    const { apply } = catchUp(share.position, buffers.get(server) ?? []);
    for (const frame of apply) applyFollowed(server, frame);
    const meanwhile = sharedMeanwhile.get(server);
    if (meanwhile) adoptShared(server, meanwhile);
    buffers.delete(server);
    sharedMeanwhile.delete(server);
    live.add(server);
  };
  const join = async (server: string) => {
    signedOut.delete(server);
    if (apis.has(server) || catching.has(server)) return;
    catching.add(server);
    // A window still opening finishes that first: its own answer may hold the server already.
    await opened;
    if (apis.has(server) || !catching.has(server)) {
      catching.delete(server);
      return;
    }
    try {
      const question: SnapshotQuestion = { only: server };
      const answer = await ask<SnapshotAnswer>(bus, OWNER, SNAPSHOT, question);
      const share = answer.servers.find((one) => one.server === server);
      // Signed out again meanwhile (letGo took it off the list), or the owner no longer has it.
      if (!catching.has(server) || !share) return;
      take(share);
      for (const heard of welcomed) heard(server);
    } catch {
      // The owner didn't answer: the server stays out of this window, as if
      // it had been signed in to after the window closed.
    } finally {
      catching.delete(server);
      if (!live.has(server)) {
        buffers.delete(server);
        sharedMeanwhile.delete(server);
      }
    }
  };

  const stops = await Promise.all([
    bus.listen<{ server: string; frame: ServerFrame }>("gateway:frame", ({ server, frame }) => {
      if (live.has(server)) {
        if (admit(positionOf(server), frame)) applyFollowed(server, frame);
        return;
      }
      if (settled && !catching.has(server)) return;
      const buffer = buffers.get(server) ?? [];
      buffer.push(frame);
      buffers.set(server, buffer);
    }),
    bus.listen<{ server: string; status: GatewayStatus }>("gateway:status", ({ server, status }) => {
      followStatus(server, status);
    }),
    bus.listen<SharedMessage>(SHARED, (message) => {
      if (message.v !== PROTOCOL || signedOut.has(message.server)) return;
      if (live.has(message.server)) adoptShared(message.server, message.shared);
      // Still catching up: the newest is kept, and applied over the snapshot
      // once it's adopted. The owner sends one whenever a value changes, so
      // the newest is never older than the snapshot.
      else if (!settled || catching.has(message.server)) sharedMeanwhile.set(message.server, message.shared);
    }),
    bus.listen<SignedOutMessage>(SIGNED_OUT, (message) => {
      if (message.v === PROTOCOL) letGo(message.server);
    }),
    bus.listen<SignedInMessage>(SIGNED_IN, (message) => {
      if (message.v === PROTOCOL) void join(message.server);
    }),
  ]);

  let settle: () => void = () => undefined;
  opened = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let answered: SnapshotAnswer;
  try {
    answered = await ask<SnapshotAnswer>(bus, OWNER, SNAPSHOT, {});
  } catch (error) {
    for (const stop of stops) stop();
    catching.clear();
    settle();
    throw error;
  }

  for (const share of answered.servers) {
    if (!signedOut.has(share.server)) take(share);
  }
  settled = true;
  // Anything still buffered belongs to a server being caught up on its own.
  for (const server of [...buffers.keys()]) if (!catching.has(server)) buffers.delete(server);
  for (const server of [...sharedMeanwhile.keys()]) if (!catching.has(server)) sharedMeanwhile.delete(server);
  settle();

  return {
    apis,
    intend: (intent) => bus.send(OWNER, INTENT, { ...intent, v: PROTOCOL, id: crypto.randomUUID(), from: bus.label }),
    onSignedOut(heard) {
      hearing.add(heard);
      return () => void hearing.delete(heard);
    },
    onSignedIn(heard) {
      welcomed.add(heard);
      return () => void welcomed.delete(heard);
    },
    stop() {
      for (const stop of stops) stop();
      for (const server of apis.keys()) unfollow(server);
    },
  };
}
