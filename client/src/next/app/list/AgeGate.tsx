import { invoke, isTauri } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { PublicApi } from "../../../lib/api";
import { forgetSession, loadSessions } from "../../../lib/ipc";
import { ASK_WITHIN_MS, type LeaveShell, phoneAge, SIGN_OUT_AGAIN_MS, signOutEverywhere } from "../../core/ageCheck";
import { onPhone } from "../../core/phone";
import { WindowMessage } from "../WindowMessage";
import { emptyShareList } from "./useShareWindow";

/**
 * Linger is for people 13 and older (#953, SPEC §4.15). On a phone the shell
 * checks the age the app store holds, where a law says the app must, before
 * the list opens: nothing signs in or connects meanwhile. A store slow to
 * answer never keeps anybody out: after `ASK_WITHIN_MS` the list opens
 * anyway. For a person under 13 the list never opens, or, for an answer
 * that came after it did, goes at once, and everything it had open with it
 * (connections, menus, notification sign-ups). What's left is one screen,
 * and every saved sign-in is signed out of (`signOutEverywhere`), and again
 * a few seconds later, for anything the list had under way. The desktop has
 * no store to ask and never checks.
 */
export function AgeGate({ children }: { children: ReactNode }) {
  const age = useSyncExternalStore(phoneAge.subscribe, phoneAge.state);
  const asks = isTauri() && onPhone();
  useEffect(() => {
    if (!asks) return;
    void phoneAge.ask(() => invoke("phone_age_check"));
    const wait = window.setTimeout(() => phoneAge.giveUp(), ASK_WITHIN_MS);
    return () => window.clearTimeout(wait);
  }, [asks]);
  useEffect(() => {
    if (age !== "child") return;
    void phoneAge.leave(() => signOutEverywhere(leaving));
    const again = SIGN_OUT_AGAIN_MS.map((after) => window.setTimeout(() => void signOutEverywhere(leaving), after));
    return () => again.forEach((timer) => window.clearTimeout(timer));
  }, [age]);
  if (age === "child") return <NotForChildren />;
  // Waiting for the store: drawn as nothing, as the update gate draws its
  // own short wait.
  if (age === "unknown" && asks) return null;
  return children;
}

/** The shell and the servers, as signing out of everything uses them. */
const leaving: LeaveShell = {
  saved: async () => {
    const loaded = await loadSessions();
    return loaded.kind === "found" ? loaded.sessions.map((each) => ({ baseUrl: each.base_url, refreshToken: each.refresh_token })) : [];
  },
  logout: (baseUrl, refreshToken) => new PublicApi(baseUrl).logout(refreshToken),
  forget: async (baseUrl) => void (await forgetSession(baseUrl)),
  shareKept: () => invoke<string[] | null>("share_sign_ins_kept"),
  shareForget: (baseUrl) => invoke<string | null>("share_sign_in_forget", { baseUrl }),
  // As signing out of the last server does: the window has nothing to offer.
  shareListClear: () => emptyShareList(),
};

/** What's left for somebody the store says is under 13: no way past it, and nothing to do. */
function NotForChildren() {
  return (
    <WindowMessage>
      <span>Linger is for people 13 and older.</span>
      <span className="nx-window-hint">The age on this phone's account is under 13, so Linger can't be used here.</span>
    </WindowMessage>
  );
}
