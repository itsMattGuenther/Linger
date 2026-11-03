import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { PublicApi } from "../../../lib/api";
import type { Sessions } from "../../../lib/session";
import {
  colorReader,
  keepShareSignIns,
  nameColor,
  oneAtATime,
  readTheme,
  connected,
  type ShareListing,
  type ShareShell,
  type ShareStatus,
  type ShareWindowServer,
  shareWindowList,
  shareWindowServers,
  writtenServers,
} from "../../core/shareWindow";

/** The shell's half (`share_window.rs`). */
const shell: ShareShell = {
  savedAt: (baseUrl) => invoke<number | null>("share_sign_in_saved_at", { baseUrl }),
  save: (baseUrl, refreshToken) => invoke<string | null>("share_sign_in_save", { baseUrl, refreshToken }),
  forget: (baseUrl) => invoke<string | null>("share_sign_in_forget", { baseUrl }),
  kept: () => invoke<string[]>("share_sign_ins_kept"),
  writeList: (list) => invoke("share_window_list_save", { list: JSON.stringify(list) }),
  readList: () => invoke<string | null>("share_window_list_read"),
};

const logout = (baseUrl: string, refreshToken: string) => new PublicApi(baseUrl).logout(refreshToken);

/** How often a running app looks again at whether a sign-in needs renewing: a phone keeps an app for days. */
const LOOK_AGAIN_MS = 6 * 60 * 60 * 1000;

/**
 * On an iPhone, keep the share window's sign-ins as the app's (#820,
 * `core/shareWindow.ts`): one asked for on each server signed in here,
 * renewed before it's old, and signed out with the server, the last one too.
 * Mounted where the sign-ins are, which is there signed in or not, so signing
 * out of the last server still signs the window out. Answers with whether the
 * window can send to each server, for its list.
 */
export function useShareSignIns(on: boolean, sessions: Sessions): ReadonlyMap<string, ShareStatus> {
  const [status, setStatus] = useState<ReadonlyMap<string, ShareStatus>>(new Map());
  const looked = useRef(new Set<string>());
  // One run at a time, so a sign-out's run comes after a run still asking,
  // and ends what it gets (#822).
  const queue = useRef(oneAtATime());
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const again = () => {
      looked.current.clear();
      setRound((was) => was + 1);
    };
    const timer = window.setInterval(again, LOOK_AGAIN_MS);
    // And whenever the app comes forward: the window drops a sign-in the
    // server has ended, and this is when to ask for another.
    const forward = () => {
      if (document.visibilityState === "visible") again();
    };
    document.addEventListener("visibilitychange", forward);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", forward);
    };
  }, [on]);

  const state = sessions.state;
  const ready = state.status === "ready";
  const servers = ready ? state.servers : [];
  // A server still being reached, or waiting for a newer app, is still signed in.
  const signedIn = ready ? [...state.servers, ...state.waiting, ...state.blocked].map((server) => server.baseUrl) : null;
  const serversKey = servers.map((server) => server.baseUrl).join("\n");
  const signedInKey = signedIn === null ? null : [...signedIn].sort().join("\n");

  useEffect(() => {
    if (!on || signedIn === null) return undefined;
    let live = true;
    const unlooked = servers.filter((server) => !looked.current.has(server.baseUrl));
    for (const server of unlooked) looked.current.add(server.baseUrl);
    const asking = unlooked.map((server) => ({ baseUrl: server.baseUrl, shareSignIn: () => server.api.shareSignIn() }));
    const stillSignedIn = new Set(signedIn);
    void queue.current(() => keepShareSignIns(asking, stillSignedIn, shell, logout, Date.now()))
      .then((found) => {
        if (live && found.size > 0) setStatus((was) => new Map([...was, ...found]));
      })
      .catch(() => undefined);
    // Signed out of every server: the window has nothing to offer.
    if (signedIn.length === 0) {
      const reader = colorReader(document);
      try {
        void shell.writeList(shareWindowList([], new Map(), readTheme(reader), (key) => nameColor(reader, key), Date.now())).catch(() => undefined);
      } finally {
        reader.done();
      }
    }
    return () => {
      live = false;
    };
    // The servers and sign-ins by address: a new object for the same ones isn't news.
  }, [on, serversKey, signedInKey, round]);

  return status;
}

/**
 * On an iPhone, write the list the share window picks from (#820) whenever
 * the list or a server's sign-in changes, a moment after, so a burst of
 * changes is written once. `signedIn` is every server signed in here, in the
 * list's order, those still being reached and waiting for a newer app too:
 * one the app isn't connected to right now is written as it last was, and
 * only signing out takes one off (`shareWindowServers`, #825). The list on
 * file is read back first, so a server not connected to yet since the app
 * started keeps what it had.
 */
export function useShareWindowList(
  on: boolean,
  signedIn: readonly string[],
  listings: readonly ShareListing[],
  status: ReadonlyMap<string, ShareStatus>,
): void {
  const last = useRef<ShareWindowServer[] | null>(null);
  const [read, setRead] = useState(false);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    void shell
      .readList()
      .catch(() => null)
      .then((text) => {
        if (!live) return;
        last.current ??= writtenServers(text);
        setRead(true);
      });
    return () => {
      live = false;
    };
  }, [on]);
  useEffect(() => {
    if (!on || !read) return undefined;
    const timer = window.setTimeout(() => {
      const reader = colorReader(document);
      try {
        const now = shareWindowList(listings.filter(connected), status, readTheme(reader), (key) => nameColor(reader, key), Date.now());
        const list = { ...now, servers: shareWindowServers(signedIn, now.servers, last.current ?? [], status) };
        last.current = list.servers;
        void shell.writeList(list).catch(() => undefined);
      } finally {
        reader.done();
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [on, read, signedIn, listings, status]);
}
