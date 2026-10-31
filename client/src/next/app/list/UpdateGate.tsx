import { isTauri } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { installPendingUpdate, pendingUpdate } from "../../../lib/updates";
import { onPhone } from "../../core/phone";
import { Spinner } from "../../kit";
import { WindowMessage } from "../WindowMessage";

type Gate = { kind: "asking" } | { kind: "installing"; version: string } | { kind: "open" };

/**
 * Before the list starts (#772): an update downloaded for this start is
 * installed first, with the window saying so, and Linger restarts into the
 * new version. Nothing connects in the meantime, so no server sees you come
 * and go. If it can't be installed (offline, say), the list starts as it is
 * and it's tried again next time. Started hidden in the tray, all of this
 * happens out of sight.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>(() => (isTauri() && !onPhone() ? { kind: "asking" } : { kind: "open" }));
  // Asked once, when the window opens: the install's answer lands on the
  // same run that asked, however the gate has changed since.
  const ask = useRef(gate.kind === "asking");
  useEffect(() => {
    if (!ask.current) return;
    let live = true;
    const open = () => {
      if (live) setGate({ kind: "open" });
    };
    void pendingUpdate().then((version) => {
      if (!live) return;
      if (version === null) {
        open();
        return;
      }
      setGate({ kind: "installing", version });
      // On success this never returns: the new Linger takes over.
      void installPendingUpdate().then(open, open);
    }, open);
    return () => {
      live = false;
    };
  }, []);
  if (gate.kind === "open") return children;
  // Asking takes a file read: nothing is drawn for that moment.
  if (gate.kind === "asking") return null;
  return (
    <WindowMessage>
      <Spinner />
      <span>{`Updating to Linger ${gate.version}…`}</span>
      <span className="nx-window-hint">Back in a few seconds.</span>
    </WindowMessage>
  );
}
