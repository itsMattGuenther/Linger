import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL, tauriBus } from "../../core/bus";
import { loadMode } from "../../core/conversations";
import { isSearchKey, isSettingsKey } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { MODE, type ModeMessage } from "../../core/share";
import { Button, Icon, IconButton, type IconName, Spinner, TitleBar } from "../../kit";
import { useFollowing } from "../useFollowing";
import { WindowMessage } from "../WindowMessage";
import "./ToolWindow.css";

/**
 * Search's and Media's windows (decision 15): viewers, like a conversation's
 * own window (docs/design/architecture.md). The frame they share: catching
 * up with the list window, the title bar, counting towards you being here,
 * closing once no server is left, coming forward with the cursor where it
 * belongs when the list asks again (`next:shown`), and going back beside the
 * list as a tab (#337).
 */
export function ToolWindow({
  title,
  icon,
  screen,
  which,
  children,
}: {
  title: string;
  icon: IconName;
  screen: string;
  which: "media" | "search";
  children: (following: Following, shown: number) => ReactNode;
}) {
  const held = useFollowing();
  if (held.kind === "waiting") {
    return (
      <WindowMessage>
        <Spinner />
        <span>Opening {title}…</span>
      </WindowMessage>
    );
  }
  if (held.kind === "lost") {
    return (
      <WindowMessage>
        <span>The list window didn't answer.</span>
        <span className="nx-window-hint">Close {title} and open it again from the list.</span>
        <Button size="sm" onClick={held.retry}>
          Try again
        </Button>
      </WindowMessage>
    );
  }
  return (
    <Frame following={held.following} title={title} icon={icon} screen={screen} which={which}>
      {children}
    </Frame>
  );
}

function Frame({
  following,
  title,
  icon,
  screen,
  which,
  children,
}: {
  following: Following;
  title: string;
  icon: IconName;
  screen: string;
  which: "media" | "search";
  children: (following: Following, shown: number) => ReactNode;
}) {
  const { intend } = following;
  // Bumped when this window is asked for again, and when servers come or go.
  const [shown, setShown] = useState(1);
  const [, setServersChanged] = useState(0);

  const reporter = useRef<Reporter | null>(null);
  useEffect(() => {
    const reporting = startReporting(intend, windowTarget());
    reporter.current = reporting;
    return () => {
      reporting.stop();
      if (reporter.current === reporting) reporter.current = null;
    };
  }, [intend]);

  const close = useCallback(() => {
    reporter.current?.stop();
    if (isTauri()) void getCurrentWindow().close();
  }, []);

  useEffect(() => {
    const out = following.onSignedOut(() => {
      if (following.apis.size === 0) close();
      else setServersChanged((count) => count + 1);
    });
    const joined = following.onSignedIn(() => setServersChanged((count) => count + 1));
    return () => {
      out();
      joined();
    };
  }, [following, close]);

  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<unknown>("next:shown", () => setShown((count) => count + 1))
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  // Ctrl+, opens Settings, as from any window. Ctrl+K puts the cursor back in
  // Search's box, or brings Search up from Media.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isSettingsKey(event)) {
        event.preventDefault();
        void intend({ kind: "settings" }).catch(() => undefined);
      } else if (isSearchKey(event)) {
        event.preventDefault();
        if (screen === "search-window") setShown((count) => count + 1);
        else void intend({ kind: "tool", which: "search" }).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [intend, screen]);

  // Back beside the list, as a tab: the list window opens it there (the
  // `tool` intent), and this window closes. Settings changing how things
  // open to beside the list does the same.
  const backBeside = useCallback(() => {
    void intend({ kind: "tool", which }).catch(() => undefined);
    close();
  }, [intend, which, close]);
  const rearrange = useRef<(mode: ModeMessage["mode"]) => void>(() => undefined);
  rearrange.current = (mode) => {
    if (mode === "tabs") backBeside();
  };
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<ModeMessage>(MODE, (message) => {
        if (message.v === PROTOCOL) rearrange.current(message.mode);
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  // Only where there's a beside to go back to: not when everything opens in windows of its own.
  const beside = storedMode() === "tabs" ? <IconButton icon="popin" label="Back beside your list" onClick={backBeside} /> : undefined;

  return (
    <div className="nx-tool" data-screen={screen}>
      <TitleBar leading={<Icon name={icon} size="md" />} actions={beside} onClose={isTauri() ? close : undefined}>
        {title}
      </TitleBar>
      <div className="nx-tool-body">{children(following, shown)}</div>
    </div>
  );
}

/** How things open on this computer, as the list window keeps it (core/conversations.ts). */
function storedMode(): "tabs" | "windows" {
  try {
    return loadMode(window.localStorage);
  } catch {
    return "tabs";
  }
}
