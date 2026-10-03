import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri, type PluginListener } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { onPhone } from "../core/phone";

/** What Back does now: the newest first (a picture over a conversation over the list). */
const handlers: { back: () => void }[] = [];
/** The one listener, while there's a handler, and which one it is. */
let listening: { id: number; held: Promise<PluginListener | null> } | null = null;
let listens = 0;

function listen(): void {
  if (listening !== null) return;
  const id = ++listens;
  const held = onBackButtonPress(() => {
    // A listener being let go still hears a press on its way out.
    if (listening?.id === id) handlers.at(-1)?.back();
  }).catch(() => null);
  listening = { id, held };
}

function stopListening(): void {
  const was = listening;
  listening = null;
  void was?.held.then((held) => held?.unregister()).catch(() => undefined);
}

/**
 * Android's back button and gesture, while there's somewhere in Linger to go
 * back to (SPEC §4.15): a picture open, a conversation over the list, a
 * Settings section. The newest of them answers. With none, nobody listens,
 * and Tauri hands Back to Android, which leaves the app, the way it should
 * from the list itself. Before this, Back in a conversation left the app
 * rather than going back to the list.
 */
export function useBackButton(active: boolean, back: () => void): void {
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (!active || !isTauri() || !onPhone()) return;
    const entry = { back: () => latest.current() };
    handlers.push(entry);
    listen();
    return () => {
      const at = handlers.indexOf(entry);
      if (at >= 0) handlers.splice(at, 1);
      if (handlers.length === 0) stopListening();
    };
  }, [active]);
}
