import { invoke, isTauri } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { phoneAge } from "../../core/ageCheck";
import { onPhone } from "../../core/phone";
import { WindowMessage } from "../WindowMessage";

/**
 * Linger is for people 13 and older (#953, SPEC §4.15). On a phone the shell
 * checks the age the app store holds, where a law says the app must, and
 * the list opens at once without waiting for it. An answer that the person
 * is under 13 takes the list's place: everything inside unmounts, which
 * closes every connection the list made, and only this screen is left. The
 * desktop has no store to ask and never checks.
 */
export function AgeGate({ children }: { children: ReactNode }) {
  const verdict = useSyncExternalStore(phoneAge.subscribe, phoneAge.verdict);
  useEffect(() => {
    if (isTauri() && onPhone()) void phoneAge.ask(() => invoke("phone_age_check"));
  }, []);
  if (verdict === "child") return <NotForChildren />;
  return children;
}

/** What's left for somebody the store says is under 13: no way past it, and nothing to do. */
function NotForChildren() {
  return (
    <WindowMessage>
      <span>Linger is for people 13 and older.</span>
      <span className="nx-window-hint">The age on this phone's account is under 13, so Linger can't be used here.</span>
    </WindowMessage>
  );
}
