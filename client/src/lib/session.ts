/**
 * Who is signed in, on which servers, and staying signed in across restarts.
 *
 * The shape of it: every server's refresh token lives in the OS keyring, and on
 * every start the client trades each one for a fresh access token and asks that
 * server who we are there. Nothing about an account is cached locally, so a name
 * or style changed on another device is right the moment the app opens.
 *
 * Since T-412 this is a list. Each server is its own sign-in with its own
 * account, its own tokens and its own keyring entry, and they do not touch each
 * other: signing out of one, or having one refuse our token, leaves the rest
 * exactly where they were.
 *
 * AGENTS allows local state plus one gateway store. This is the local half; the
 * gateway store is `./gateway.ts`. The split is deliberate — who you are outlives
 * any one connection, and the connection is not this file's business.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthResponse } from "../generated/AuthResponse";
import type { User } from "../generated/User";
import { ApiError, AuthedApi, expiryOf, PublicApi, type Tokens } from "./api";
import { forgetSession, loadSessions, saveSession } from "./ipc";
import { hostOf } from "./link";

/** One signed-in server. */
export interface ServerSession {
  /** Origin of the server. The key everything else is filed under. */
  baseUrl: string;
  api: AuthedApi;
  user: User;
}

/**
 * A saved server that hasn't come back yet this launch (T-907). Its sign-in is
 * kept, and Linger keeps trying, so it joins the list when it answers.
 */
export interface WaitingServer {
  baseUrl: string;
  /** Why the last try failed; null while a try is under way. */
  why: string | null;
}

export type SessionsState =
  | { status: "restoring" }
  /**
   * Every server we are signed into, oldest first (empty means signed out,
   * unless some are still `waiting`), and the saved servers still being
   * reached.
   */
  | { status: "ready"; servers: ServerSession[]; waiting: WaitingServer[] };

export interface Sessions {
  state: SessionsState;
  /**
   * Set when this computer can't remember a sign-in — no wallet, a locked one,
   * or the UI running in a plain browser. Screens show it so the person finds
   * out before they're surprised by it, not after.
   */
  keyringNotice: string | null;
  /** Why a sign-in ended, when it ended on its own. */
  notice: string | null;
  /** Sign into a server, or sign back into one already in the list. */
  addServer: (baseUrl: string, auth: AuthResponse) => Promise<void>;
  /** Sign out of one server, waiting or not. The others are untouched. */
  signOut: (baseUrl: string) => Promise<void>;
  /** Try a waiting server now rather than at its next turn. */
  retry: (baseUrl: string) => void;
}

/**
 * The longest the window waits for the saved servers before showing the ones
 * that answered (T-907). The first to answer ends the wait sooner; this is for
 * a launch where none has yet.
 */
export const RESTORE_WAIT_MS = 5_000;

/** Between tries at a server that couldn't be reached: soon, then less often. */
export const RETRY_AFTER_MS = [5_000, 15_000, 30_000, 60_000] as const;

/** How one try at a saved server's sign-in went. */
type Refreshed =
  | { kind: "ok"; tokens: Tokens }
  /** The server refused it: the sign-in is over, and forgotten. */
  | { kind: "refused"; notice: string }
  /** No answer, or not one we could read: the sign-in is kept. */
  | { kind: "unreachable"; why: string }
  /** Signed out of while the try was under way, or nothing saved for it. */
  | { kind: "gone" };

/**
 * Restoring must happen exactly once per launch. Refresh tokens rotate and
 * spending one twice revokes the whole family (PROTOCOL §2), so React's
 * StrictMode double-mount in development would otherwise sign the user out —
 * a bug that would only ever appear on a dev machine. Keeping the promise at
 * module scope makes the second mount await the first attempt instead of
 * starting its own.
 */
let restoreOnce: Promise<Restoring> | null = null;

interface Restoring {
  keyringNotice: string | null;
  /** The saved servers, in the order they were saved, each with its first try under way. */
  saved: { baseUrl: string; first: Promise<Refreshed> }[];
}

/**
 * The try under way at each server, if any. One at a time per server, from
 * reading the keyring to saving what comes back, so no saved token is ever
 * presented twice, however many mounts, timers and buttons ask.
 */
const trying = new Map<string, Promise<Refreshed>>();

/**
 * Servers signed out of this launch. A try already under way when that
 * happened must not write its fresh token back to the keyring.
 */
const forgotten = new Set<string>();

function once(baseUrl: string, attempt: () => Promise<Refreshed>): Promise<Refreshed> {
  const running = trying.get(baseUrl);
  if (running) return running;
  const next = attempt().finally(() => trying.delete(baseUrl));
  trying.set(baseUrl, next);
  return next;
}

/** Trade one stored refresh token for a live one. */
async function refreshSaved(baseUrl: string, refreshToken: string): Promise<Refreshed> {
  try {
    const fresh = await new PublicApi(baseUrl).refresh({ refresh_token: refreshToken });
    if (forgotten.has(baseUrl)) {
      // Signed out while this was on its way: end the new token too.
      await new PublicApi(baseUrl).logout(fresh.refresh_token).catch(() => undefined);
      return { kind: "gone" };
    }
    await saveSession({ base_url: baseUrl, refresh_token: fresh.refresh_token });
    return {
      kind: "ok",
      tokens: {
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token,
        expiresAt: expiryOf(fresh.expires_in),
      },
    };
  } catch (error) {
    // A refused token is genuinely dead, so forget it. Anything else — the
    // server is down, the laptop is on a train — leaves it in place, because
    // it will very likely work on the next try.
    const refused =
      error instanceof ApiError &&
      (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN");
    if (refused) {
      await forgetSession(baseUrl);
      return { kind: "refused", notice: `${hostOf(baseUrl)}: Your saved sign-in is no longer valid. Please sign in again.` };
    }
    return { kind: "unreachable", why: error instanceof Error ? error.message : "Couldn't restore your last sign-in." };
  }
}

/** Try a saved server again, with the sign-in the keyring holds now. */
function refreshAgain(baseUrl: string): Promise<Refreshed> {
  return once(baseUrl, async () => {
    const loaded = await loadSessions();
    const stored = loaded.kind === "found" ? loaded.sessions.find((one) => one.base_url === baseUrl) : undefined;
    if (!stored || forgotten.has(baseUrl)) return { kind: "gone" };
    return refreshSaved(baseUrl, stored.refresh_token);
  });
}

async function restore(): Promise<Restoring> {
  const loaded = await loadSessions();
  if (loaded.kind === "unavailable") return { keyringNotice: loaded.reason, saved: [] };
  if (loaded.kind === "empty") return { keyringNotice: null, saved: [] };
  // Each on its own. One server being slow or down holds up none of the
  // others (T-907), and refresh tokens rotate per server, so there is nothing
  // shared to serialize on.
  return {
    keyringNotice: null,
    saved: loaded.sessions.map((stored) => ({
      baseUrl: stored.base_url,
      first: once(stored.base_url, () => refreshSaved(stored.base_url, stored.refresh_token)),
    })),
  };
}

/** What the hook holds: the servers, the waiting ones, and whether the wait is over. */
interface Held {
  shown: boolean;
  servers: ServerSession[];
  waiting: WaitingServer[];
}

/**
 * The wait ends when a server is in, or when every saved one has answered
 * somehow: there's nothing more to wait for.
 */
function settled(held: Held): Held {
  if (held.shown) return held;
  return held.servers.length > 0 || held.waiting.every((one) => one.why !== null) ? { ...held, shown: true } : held;
}

function withWaiting(waiting: readonly WaitingServer[], one: WaitingServer): WaitingServer[] {
  const at = waiting.findIndex((held) => held.baseUrl === one.baseUrl);
  if (at < 0) return [...waiting, one];
  const next = [...waiting];
  next[at] = one;
  return next;
}

export function useSessions(): Sessions {
  const [held, setHeld] = useState<Held>({ shown: false, servers: [], waiting: [] });
  const [keyringNotice, setKeyringNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  /** Which mount is current: a StrictMode rehearsal's answers are dropped. */
  const run = useRef(0);
  /** The saved order, so a server that comes back late takes its own place. */
  const order = useRef<string[]>([]);
  /**
   * Each waiting server's next try: its timer, how many tries have failed,
   * whether one is under way (a second would spend the token the first just
   * saved), and the connection to reuse when the token came back but `me`
   * didn't.
   */
  const retries = useRef(new Map<string, { timer: number | null; tries: number; busy: boolean; api: AuthedApi | null }>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const state = useMemo<SessionsState>(
    () => (held.shown ? { status: "ready", servers: held.servers, waiting: held.waiting } : { status: "restoring" }),
    [held],
  );

  const addNotice = useCallback((line: string) => {
    setNotice((was) => (was === null ? line : `${was} ${line}`));
  }, []);

  /** Stop trying a server, and take it off the waiting list. */
  const stopWaiting = useCallback((baseUrl: string) => {
    const retry = retries.current.get(baseUrl);
    if (retry?.timer != null) window.clearTimeout(retry.timer);
    retries.current.delete(baseUrl);
    setHeld((was) => settled({ ...was, waiting: was.waiting.filter((one) => one.baseUrl !== baseUrl) }));
  }, []);

  /** Drop one server from the list, leaving the rest alone. */
  const remove = useCallback((baseUrl: string) => {
    setHeld((was) => ({ ...was, servers: was.servers.filter((s) => s.baseUrl !== baseUrl) }));
  }, []);

  /** Put a server in the list in its saved place, and off the waiting list. */
  const arrive = useCallback((session: ServerSession) => {
    const retry = retries.current.get(session.baseUrl);
    if (retry?.timer != null) window.clearTimeout(retry.timer);
    retries.current.delete(session.baseUrl);
    if (!order.current.includes(session.baseUrl)) order.current.push(session.baseUrl);
    const rank = (baseUrl: string) => order.current.indexOf(baseUrl);
    setHeld((was) => {
      const at = was.servers.findIndex((server) => server.baseUrl === session.baseUrl);
      // Signing back into a server you already have keeps its place in the
      // rail rather than sending it to the bottom of the list.
      const servers = at < 0 ? [...was.servers, session] : was.servers.map((server, index) => (index === at ? session : server));
      if (at < 0) servers.sort((a, b) => rank(a.baseUrl) - rank(b.baseUrl));
      return settled({ ...was, servers, waiting: was.waiting.filter((one) => one.baseUrl !== session.baseUrl) });
    });
  }, []);

  /**
   * Build the connection to one server. Rotated tokens are written back to the
   * keyring as they arrive, so the stored token is always the live one — if the
   * app is killed a second later, the next launch still works.
   */
  const connect = useCallback(
    (baseUrl: string, tokens: Tokens): AuthedApi => {
      return new AuthedApi(baseUrl, tokens, {
        onTokens: (fresh) => {
          void saveSession({ base_url: baseUrl, refresh_token: fresh.refreshToken }).then(
            (result) => {
              if (result.kind === "unavailable" && mounted.current) {
                setKeyringNotice(result.reason);
              }
            },
          );
        },
        onSignedOut: (reason) => {
          if (!mounted.current) return;
          // Only this server. A token going stale on one machine's account
          // says nothing about the others.
          void forgetSession(baseUrl);
          setNotice(`${hostOf(baseUrl)}: ${reason}`);
          remove(baseUrl);
          stopWaiting(baseUrl);
        },
      });
    },
    [remove, stopWaiting],
  );

  // The tries themselves. Kept in a ref so timers, the button and the first
  // mount all call the current one.
  const tries = useRef<{
    follow: (baseUrl: string, attempt: Promise<Refreshed>, mount: number) => Promise<void>;
    open: (baseUrl: string, api: AuthedApi, mount: number) => Promise<void>;
    again: (baseUrl: string) => void;
  } | null>(null);
  tries.current = {
    follow: async (baseUrl, attempt, mount) => {
      const result = await attempt;
      if (!mounted.current || mount !== run.current) return;
      switch (result.kind) {
        case "gone":
          stopWaiting(baseUrl);
          return;
        case "refused":
          addNotice(result.notice);
          stopWaiting(baseUrl);
          return;
        case "unreachable":
          wait(baseUrl, result.why, null);
          return;
        case "ok":
          await tries.current?.open(baseUrl, connect(baseUrl, result.tokens), mount);
      }
    },
    open: async (baseUrl, api, mount) => {
      try {
        const user = await api.me();
        if (!mounted.current || mount !== run.current) return;
        if (forgotten.has(baseUrl)) {
          await new PublicApi(baseUrl).logout(api.refreshToken).catch(() => undefined);
          return;
        }
        arrive({ baseUrl, api, user });
      } catch (error) {
        if (!mounted.current || mount !== run.current) return;
        // A refused token has already signed this server out (`onSignedOut`).
        if (error instanceof ApiError && (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")) return;
        wait(baseUrl, error instanceof Error ? error.message : "Couldn't sign you back in.", api);
      }
    },
    again: (baseUrl) => {
      const retry = retries.current.get(baseUrl);
      if (!retry || retry.busy) return;
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retries.current.set(baseUrl, { ...retry, timer: null, busy: true });
      setHeld((was) => ({ ...was, waiting: withWaiting(was.waiting, { baseUrl, why: null }) }));
      const mount = run.current;
      if (retry.api) void tries.current?.open(baseUrl, retry.api, mount);
      else void tries.current?.follow(baseUrl, refreshAgain(baseUrl), mount);
    },
  };

  /** A try failed without ending the sign-in: say why, and try again later. */
  function wait(baseUrl: string, why: string, api: AuthedApi | null): void {
    const was = retries.current.get(baseUrl);
    if (was?.timer != null) window.clearTimeout(was.timer);
    const failed = (was?.tries ?? 0) + 1;
    const delay = RETRY_AFTER_MS[Math.min(failed, RETRY_AFTER_MS.length) - 1] ?? RETRY_AFTER_MS[0];
    const timer = window.setTimeout(() => tries.current?.again(baseUrl), delay);
    retries.current.set(baseUrl, { timer, tries: failed, busy: false, api: api ?? was?.api ?? null });
    setHeld((held) => settled({ ...held, waiting: withWaiting(held.waiting, { baseUrl, why }) }));
  }

  useEffect(() => {
    run.current += 1;
    const mount = run.current;
    restoreOnce ??= restore();
    let wake: number | null = null;
    void restoreOnce.then((restoring) => {
      if (!mounted.current || mount !== run.current) return;
      setKeyringNotice(restoring.keyringNotice);
      order.current = restoring.saved.map((saved) => saved.baseUrl);
      setHeld((was) =>
        settled({ ...was, waiting: restoring.saved.map((saved) => ({ baseUrl: saved.baseUrl, why: null })) }),
      );
      for (const saved of restoring.saved) {
        retries.current.set(saved.baseUrl, { timer: null, tries: 0, busy: true, api: null });
        void tries.current?.follow(saved.baseUrl, saved.first, mount);
      }
      wake = window.setTimeout(() => setHeld((was) => (was.shown ? was : { ...was, shown: true })), RESTORE_WAIT_MS);
    });
    const pending = retries.current;
    return () => {
      if (wake !== null) window.clearTimeout(wake);
      for (const retry of pending.values()) if (retry.timer !== null) window.clearTimeout(retry.timer);
      pending.clear();
    };
  }, []);

  const addServer = useCallback(
    async (baseUrl: string, auth: AuthResponse) => {
      const tokens: Tokens = {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        expiresAt: expiryOf(auth.expires_in),
      };
      forgotten.delete(baseUrl);
      const stored = await saveSession({
        base_url: baseUrl,
        refresh_token: auth.refresh_token,
      });
      if (!mounted.current) return;
      setKeyringNotice(stored.kind === "unavailable" ? stored.reason : null);
      setNotice(null);
      arrive({ baseUrl, api: connect(baseUrl, tokens), user: auth.user });
    },
    [arrive, connect],
  );

  const signOut = useCallback(
    async (baseUrl: string) => {
      const leaving = held.servers.find((server) => server.baseUrl === baseUrl);
      forgotten.add(baseUrl);
      remove(baseUrl);
      stopWaiting(baseUrl);
      setNotice(null);
      await forgetSession(baseUrl);
      if (leaving) {
        // Best effort: this revokes the token family server-side, but a failure
        // here must not keep someone signed in on their own screen.
        await new PublicApi(baseUrl).logout(leaving.api.refreshToken).catch(() => undefined);
      }
    },
    [remove, stopWaiting, held],
  );

  const retry = useCallback((baseUrl: string) => tries.current?.again(baseUrl), []);

  return { state, keyringNotice, notice, addServer, signOut, retry };
}
