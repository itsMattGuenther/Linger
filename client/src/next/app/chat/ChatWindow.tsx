import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { AuthedApi } from "../../../lib/api";
import { serverState } from "../../../lib/gateway";
import { loadVoicePrefs } from "../../../lib/voice";
import { isTalkKey } from "../../core/talkKey";
import { PROTOCOL, tauriBus } from "../../core/bus";
import { conversationIn } from "../../core/chat/conversation";
import { leaveDraft, takeDraft } from "../../core/handoff";
import { isSearchKey, isSettingsKey, tabCommand } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { MODE, type ModeMessage } from "../../core/share";
import { keyOf, type TabKey } from "../../core/tabs";
import { Button, Spinner, type TabItem } from "../../kit";
import { useFollowing } from "../useFollowing";
import { WindowMessage } from "../WindowMessage";
import { ChatView } from "./ChatView";
import { draftStore, useConversationPane } from "./useConversationPane";

/**
 * A conversation in a window of its own: a viewer (docs/design/architecture.md,
 * "Windows and their roles"), popped out of the tabs beside the list, or
 * opened here because conversations open each in its own window (Settings →
 * Windows). It catches up with the list window's connection and follows it,
 * and asks the list window for what only the owner may do: marking read,
 * placing you in a room, and voice.
 */
export function ChatWindow() {
  const held = useFollowing();

  if (held.kind === "waiting") {
    return (
      <WindowMessage>
        <Spinner />
        <span>Opening the conversation…</span>
      </WindowMessage>
    );
  }
  if (held.kind === "lost") {
    return (
      <WindowMessage>
        <span>The list window didn't answer.</span>
        <span className="nx-window-hint">Close this window and open the conversation from the list again.</span>
        <Button size="sm" onClick={held.retry}>
          Try again
        </Button>
      </WindowMessage>
    );
  }
  return <OwnWindow following={held.following} />;
}

/** The conversation this window was opened on (window.rs, `next_open_conversation`), if it's one of yours. */
function openedOn(apis: ReadonlyMap<string, AuthedApi>): { tab: TabKey; message: MessageId | null } | null {
  const query = new URLSearchParams(window.location.search);
  const server = query.get("server");
  const room = query.get("room");
  if (server === null || room === null || !apis.has(server)) return null;
  return { tab: { server, roomId: room }, message: query.get("message") };
}

function OwnWindow({ following }: { following: Following }) {
  const { apis, intend } = following;
  const [opened] = useState(() => openedOn(apis));
  const tab = opened?.tab ?? null;
  const [gone, setGone] = useState(tab === null);
  const reporter = useRef<Reporter | null>(null);
  const intendNow = useRef(intend);
  intendNow.current = intend;
  // A draft that came with the conversation from beside the list.
  const [firstSeed] = useState(() => {
    const store = draftStore();
    const text = store && tab ? takeDraft(store, keyOf(tab), Date.now()) : null;
    return tab && text !== null ? { conversation: keyOf(tab), text } : null;
  });
  const [firstMessage] = useState(() => (opened && opened.message !== null ? { tab: opened.tab, id: opened.message } : null));
  // A brand new DM reaches this window as its own frame, after the list
  // asked for it: until it's been seen, it isn't taken for gone.
  const waiting = useRef(tab !== null && conversationIn(serverState(tab.server), tab.roomId) === null);

  const find = useCallback((id: string): TabKey | undefined => (tab && keyOf(tab) === id ? tab : undefined), [tab]);
  // A DM opened from a person's card shows wherever conversations open.
  const show = useCallback(
    (server: string, roomId: RoomId) => void intend({ kind: "open", server, roomId, conversation: "dm" }).catch(() => undefined),
    [intend],
  );
  const view = useConversationPane({ apis, intend, active: gone ? null : tab, find, show, firstSeed, firstMessage });
  const { servers, goToMessage, askFocus, draftOf, tabItem } = view;

  const closeWindow = useCallback(() => {
    reporter.current?.stop();
    if (isTauri()) void getCurrentWindow().close();
  }, []);

  // Brought forward on a message (a search hit, a banner) while already
  // open: the shell hands it over as an event (window.rs, `next_open_conversation`).
  useEffect(() => {
    if (!isTauri() || tab === null) return;
    let stop: (() => void) | null = null;
    let quit = false;
    void tauriBus()
      .listen<{ server: string; room: string; message?: string | null }>("next:open", ({ server, room, message }) => {
        if (server !== tab.server || room !== tab.roomId) return;
        if (message) goToMessage(tab, message);
        askFocus();
      })
      .then((unlisten) => {
        if (quit) unlisten();
        else stop = unlisten;
      });
    return () => {
      quit = true;
      stop?.();
    };
  }, [tab, goToMessage, askFocus]);

  // Signed out of its server, or the conversation's gone (a room archived,
  // a DM you were taken out of) once its server has said what exists: the
  // window has nothing to show, and closes.
  useEffect(() => following.onSignedOut((server) => server === tab?.server && setGone(true)), [following, tab]);
  useEffect(() => {
    if (tab === null) return;
    const state = servers[tab.server];
    if (state === undefined || state.me === null) return;
    if (conversationIn(state, tab.roomId) !== null) waiting.current = false;
    else if (!waiting.current) setGone(true);
  }, [servers, tab]);
  useEffect(() => {
    if (gone) closeWindow();
  }, [gone, closeWindow]);

  // Presence: this window's focus, the person moving in it, the conversation
  // on screen, and its closing, all reported to the owner (core/report.ts).
  useEffect(() => {
    const reporting = startReporting(intend, windowTarget());
    reporter.current = reporting;
    if (tab) reporting.showing(tab.server, tab.roomId);
    return () => {
      reporting.stop();
      if (reporter.current === reporting) reporter.current = null;
    };
  }, [intend, tab]);

  // Back beside the list, as a tab: the owner shows it there, and the draft
  // goes along (core/handoff.ts).
  const backBeside = useCallback(() => {
    const store = draftStore();
    if (!tab) return;
    if (store) leaveDraft(store, keyOf(tab), draftOf(keyOf(tab)), Date.now());
    void intend({ kind: "tabs", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
    setGone(true);
  }, [tab, intend, draftOf]);

  // Settings changed how conversations open to beside the list: this one goes back there.
  const rearrange = useRef<(mode: ModeMessage["mode"]) => void>(() => undefined);
  rearrange.current = (mode) => {
    if (mode === "tabs") backBeside();
  };
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let quit = false;
    void tauriBus()
      .listen<ModeMessage>(MODE, (message) => {
        if (message.v === PROTOCOL) rearrange.current(message.mode);
      })
      .then((unlisten) => {
        if (quit) unlisten();
        else stop = unlisten;
      });
    return () => {
      quit = true;
      stop?.();
    };
  }, []);

  // Ctrl+, and Ctrl+K ask the list window for Settings and Search; Ctrl+W
  // closes the window, as it closes a tab (core/keys.ts). Taken before the
  // focused control sees them, so they work from the message box too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isSettingsKey(event)) {
        event.preventDefault();
        void intendNow.current({ kind: "settings" }).catch(() => undefined);
        return;
      }
      if (isSearchKey(event)) {
        event.preventDefault();
        void intendNow.current({ kind: "tool", which: "search" }).catch(() => undefined);
        return;
      }
      const command = tabCommand(event);
      if (command === null) return;
      event.preventDefault();
      if (command.kind === "close") setGone(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Push-to-talk works in this window too; the owner holds the microphone.
  const pushToTalk = Object.values(servers).some((state) => state.myVoice?.pushToTalk === true);
  useEffect(() => {
    if (!pushToTalk) return;
    const say = (down: boolean) => void intend({ kind: "voice.talk", down }).catch(() => undefined);
    const down = (event: KeyboardEvent) => {
      if (isTalkKey(event, loadVoicePrefs().pushToTalkKey) && !event.repeat) say(true);
    };
    const up = (event: KeyboardEvent) => {
      if (isTalkKey(event, loadVoicePrefs().pushToTalkKey)) say(false);
    };
    const release = () => say(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [pushToTalk, intend]);

  const items = useMemo((): TabItem[] => {
    const item = tab ? tabItem(tab, true) : null;
    return item ? [item] : [];
  }, [tab, tabItem]);

  if (gone || tab === null) return null;

  return (
    <>
      <ChatView
        tabs={items}
        activeId={keyOf(tab)}
        onSelectTab={() => undefined}
        onCloseTab={() => setGone(true)}
        single={{ onBackBeside: backBeside }}
        // Closing lets the conversation go first, so closing is the last thing
        // the window tells the list window, never a read that came after it.
        onCloseWindow={isTauri() ? () => setGone(true) : undefined}
        pane={view.pane}
      />
      {view.card}
    </>
  );
}
