import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { AuthedApi } from "../../../lib/api";
import { serverState } from "../../../lib/gateway";
import { loadVoicePrefs } from "../../../lib/voice";
import { isTalkKey } from "../../core/talkKey";
import { ask, OWNER, PROTOCOL, tauriBus } from "../../core/bus";
import { conversationIn } from "../../core/chat/conversation";
import { leaveDraft, takeDraft } from "../../core/handoff";
import { isSearchKey, isSettingsKey, tabCommand } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { MODE, type ModeMessage, OPENS, type OpensAnswer } from "../../core/share";
import { closeTab, keepOnly, keyOf, loadTabs, moveTab, openTab, same, saveTabs, selectTab, stepTab, type TabKey, type Tabs } from "../../core/tabs";
import { Button, Spinner, type TabItem } from "../../kit";
import { useFollowing } from "../useFollowing";
import { WindowMessage } from "../WindowMessage";
import { ChatView } from "./ChatView";
import { draftStore, useConversationPane } from "./useConversationPane";

/** Open tabs and their order, on this computer (docs/design/architecture.md, "Remembering"). */
const TABS_KEY = "linger.next.tabs";

/**
 * The chat window: a viewer (docs/design/architecture.md, "Windows and their
 * roles"). It catches up with the list window's connection and follows it,
 * shows conversations in tabs, and asks the list window for what only the
 * owner may do: marking read, placing you in a room, and voice.
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
  return <Conversations following={held.following} />;
}

/** This window shows one conversation in a window of its own (window.rs, `next_open_conversation`). */
const SINGLE = new URLSearchParams(window.location.search).get("single") === "1";

/** The tabs this window starts with: the ones remembered, and the one it was opened on. */
function firstTabs(apis: ReadonlyMap<string, AuthedApi>): Tabs {
  let remembered: string | null = null;
  try {
    // A window of its own shows just the one conversation it was opened on.
    remembered = SINGLE ? null : window.localStorage.getItem(TABS_KEY);
  } catch {
    // Storage refused: start with just the conversation asked for.
  }
  let tabs = keepOnly(loadTabs(remembered), (tab) => apis.has(tab.server));
  const query = new URLSearchParams(window.location.search);
  const server = query.get("server");
  const room = query.get("room");
  if (server !== null && room !== null && apis.has(server)) tabs = openTab(tabs, { server, roomId: room });
  return tabs;
}

/** The conversation this window was opened on, if this window hasn't heard of it yet. */
function unseenAtOpen(apis: ReadonlyMap<string, AuthedApi>): Set<string> {
  const query = new URLSearchParams(window.location.search);
  const server = query.get("server");
  const room = query.get("room");
  const unseen = new Set<string>();
  if (server !== null && room !== null && apis.has(server) && conversationIn(serverState(server), room) === null) {
    unseen.add(keyOf({ server, roomId: room }));
  }
  return unseen;
}

function Conversations({ following }: { following: Following }) {
  const { apis, intend } = following;
  const [tabs, setTabs] = useState<Tabs>(() => firstTabs(apis));
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const find = useCallback((id: string): TabKey | undefined => tabsNow.current.open.find((tab) => keyOf(tab) === id), []);
  const reporter = useRef<Reporter | null>(null);
  const intendNow = useRef(intend);
  intendNow.current = intend;
  // A draft that came with the first conversation from another window.
  const [firstSeed] = useState(() => {
    const store = draftStore();
    const first = tabs.active;
    const text = store && first ? takeDraft(store, keyOf(first), Date.now()) : null;
    return first && text !== null ? { conversation: keyOf(first), text } : null;
  });

  // Conversations opened (or this window opened on) that it hasn't seen yet:
  // a brand new DM reaches this window as its own frame, after the list asked
  // for it. Such a tab waits for it rather than being taken for gone.
  const [waiting] = useState(() => unseenAtOpen(apis));

  const openedRef = useRef<(server: string, roomId: string, messageId?: MessageId | null) => void>(() => undefined);
  // A DM opened from a person's card shows here: as a tab, or, in a window of
  // its own, wherever conversations open.
  const show = useCallback(
    (server: string, roomId: RoomId) => {
      if (SINGLE) void intend({ kind: "open", server, roomId, conversation: "dm" }).catch(() => undefined);
      else openedRef.current(server, roomId);
    },
    [intend],
  );
  // Opened on a message: the address says which (window.rs, `at_message`).
  const [firstMessage] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    const server = query.get("server");
    const room = query.get("room");
    const message = query.get("message");
    return server !== null && room !== null && message !== null && apis.has(server) ? { tab: { server, roomId: room }, id: message } : null;
  });
  const active = tabs.active;
  const view = useConversationPane({ apis, intend, active, find, show, firstSeed, firstMessage });
  const { servers, goToMessage, askFocus, seedDraft, draftOf } = view;

  // Opened from the list while this window is already open (window.rs,
  // `next_open_chat`). Once listening, the tabs window asks the list window
  // for anything it was sent before it was (OPENS in core/share.ts).
  const opened = useCallback(
    (server: string, roomId: string, messageId?: MessageId | null) => {
      if (!apis.has(server)) return;
      const tab = { server, roomId };
      const state = serverState(server);
      if (conversationIn(state, roomId) === null) waiting.add(keyOf(tab));
      // Before the tab shows, so its first load is the window around the message.
      if (messageId) goToMessage(tab, messageId);
      setTabs((held) => openTab(held, tab));
      askFocus();
      // Back from a window of its own, perhaps with a draft.
      const store = draftStore();
      const text = store ? takeDraft(store, keyOf(tab), Date.now()) : null;
      if (text !== null) seedDraft(keyOf(tab), text);
    },
    [apis, waiting, goToMessage, askFocus, seedDraft],
  );
  openedRef.current = opened;

  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    const bus = tauriBus();
    void bus
      .listen<{ server: string; room: string; message?: string | null }>("next:open", ({ server, room, message }) => opened(server, room, message))
      .then((unlisten) => {
        if (gone) {
          unlisten();
          return;
        }
        stop = unlisten;
        if (SINGLE) return;
        // What was missed is handed over once, so it's opened even if this
        // effect is already being cleaned up.
        void ask<OpensAnswer>(bus, OWNER, OPENS, {})
          .then(({ opens }) => {
            for (const { server, roomId, messageId } of opens) opened(server, roomId, messageId);
          })
          .catch(() => undefined);
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [opened]);

  // A server signed out of takes its tabs with it; with none left, the
  // window closes.
  useEffect(() => following.onSignedOut((server) => setTabs((held) => keepOnly(held, (tab) => tab.server !== server))), [following]);

  // A conversation that's gone (a room archived, a DM you were taken out of)
  // loses its tab, once its server has told this window what exists. One
  // still on its way keeps its tab until it has been seen.
  useEffect(() => {
    setTabs((held) =>
      keepOnly(held, (tab) => {
        const state = servers[tab.server];
        if (state === undefined || state.me === null) return true;
        if (conversationIn(state, tab.roomId) === null) return waiting.has(keyOf(tab));
        waiting.delete(keyOf(tab));
        return true;
      }),
    );
  }, [servers]);

  useEffect(() => {
    if (SINGLE) return;
    try {
      window.localStorage.setItem(TABS_KEY, saveTabs(tabs));
    } catch {
      // Storage refused: the tabs just won't come back after a restart.
    }
  }, [tabs]);

  // Presence: this window's focus, the person moving in it, the conversation
  // on screen, and its closing, all reported to the owner (core/report.ts).
  useEffect(() => {
    const reporting = startReporting(intend, windowTarget());
    reporter.current = reporting;
    return () => {
      reporting.stop();
      if (reporter.current === reporting) reporter.current = null;
    };
  }, [intend]);
  useEffect(() => {
    if (active) reporter.current?.showing(active.server, active.roomId);
  }, [active]);

  const closeWindow = useCallback(() => {
    reporter.current?.stop();
    if (isTauri()) void getCurrentWindow().close();
  }, []);

  // A tab into a window of its own, and back: the owner opens windows, and
  // the draft goes along (core/handoff.ts).
  const popOut = useCallback(
    (id: string) => {
      const tab = find(id);
      const store = draftStore();
      if (!tab) return;
      if (store) leaveDraft(store, id, draftOf(id), Date.now());
      void intend({ kind: "popout", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
      setTabs((held) => closeTab(held, tab));
    },
    [find, intend, draftOf],
  );
  const backToTabs = useCallback(() => {
    const tab = tabsNow.current.active;
    const store = draftStore();
    if (!tab) return;
    if (store) leaveDraft(store, keyOf(tab), draftOf(keyOf(tab)), Date.now());
    void intend({ kind: "tabs", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
    closeWindow();
  }, [intend, closeWindow, draftOf]);

  // Settings changed how conversations open, and whatever is open moves at
  // once: every tab into a window of its own (the one showing last, so it
  // lands on top), or every window of its own back into the tabs.
  const rearrange = useRef<(mode: ModeMessage["mode"]) => void>(() => undefined);
  rearrange.current = (mode) => {
    if (mode === "tabs" && SINGLE) {
      backToTabs();
      return;
    }
    if (mode !== "windows" || SINGLE) return;
    const { open, active } = tabsNow.current;
    const store = draftStore();
    for (const tab of [...open.filter((held) => !same(held, active)), ...open.filter((held) => same(held, active))]) {
      if (store) leaveDraft(store, keyOf(tab), draftOf(keyOf(tab)), Date.now());
      void intend({ kind: "popout", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
    }
    setTabs({ open: [], active: null });
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

  // A window with no conversations left has nothing to show: it closes.
  const empty = tabs.open.length === 0;
  useEffect(() => {
    if (empty) closeWindow();
  }, [empty, closeWindow]);

  // Tab shortcuts (core/keys.ts). Taken before the focused control sees them,
  // so they work from the message box too.
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
      setTabs((held) => {
        if (command.kind === "step") return stepTab(held, command.by);
        if (command.kind === "move") {
          const at = held.open.findIndex((tab) => same(tab, held.active));
          return held.active && at >= 0 ? moveTab(held, held.active, at + command.by) : held;
        }
        if (command.kind === "close") return held.active ? closeTab(held, held.active) : held;
        const tab = command.to === "last" ? held.open.at(-1) : held.open[command.to];
        return tab ? selectTab(held, tab) : held;
      });
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

  const { tabItem } = view;
  const items = useMemo(
    () => tabs.open.flatMap((tab): TabItem[] => {
      const item = tabItem(tab, same(tab, tabs.active));
      return item ? [item] : [];
    }),
    [tabs, tabItem],
  );

  if (empty) return null;

  const paneId = active ? keyOf(active) : null;
  return (
    <>
      <ChatView
        tabs={items}
        activeId={paneId}
        onSelectTab={(id) => {
          const tab = find(id);
          if (tab) setTabs((held) => selectTab(held, tab));
        }}
        onCloseTab={(id) => {
          const tab = find(id);
          if (tab) setTabs((held) => closeTab(held, tab));
        }}
        onMoveTab={(id, to) => {
          const tab = find(id);
          if (tab) setTabs((held) => moveTab(held, tab, to));
        }}
        onPopOut={SINGLE ? undefined : popOut}
        single={SINGLE ? { onBackToTabs: backToTabs } : undefined}
        onCloseWindow={isTauri() ? closeWindow : undefined}
        pane={view.pane}
      />
      {view.card}
    </>
  );
}
