import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri, type PluginListener } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { onPhone } from "../core/phone";

/**
 * Android's back button and gesture, while there's somewhere in Linger to go
 * back to (SPEC §4.15): a conversation over the list, or a Settings section.
 * Only while `active`: with nobody listening, Tauri hands Back to Android,
 * which leaves the app, the way it should from the list itself. Before this,
 * Back in a conversation left the app rather than going back to the list.
 */
export function useBackButton(active: boolean, back: () => void): void {
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (!active || !isTauri() || !onPhone()) return;
    let listener: PluginListener | null = null;
    let gone = false;
    void onBackButtonPress(() => latest.current())
      .then((held) => {
        if (gone) void held.unregister();
        else listener = held;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      void listener?.unregister();
    };
  }, [active]);
}
