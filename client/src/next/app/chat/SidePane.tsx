import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { AuthedApi } from "../../../lib/api";
import { leaveDraft, takeDraft } from "../../core/handoff";
import { tabCommand } from "../../core/keys";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import type { Intent, VoiceControlQuestion } from "../../core/share";
import { closeTab, isPreview, isTool, keepTab, keyOf, moveTab, openTab, previewTab, same, selectTab, type SideTab, stepTab, type TabKey, type Tabs } from "../../core/tabs";
import { IconButton, type TabItem } from "../../kit";
import { MediaPanel, type OpenFound, SearchPanel } from "../tools/panels";
import { ChatView } from "./ChatView";
import { draftStore, useConversationPane } from "./useConversationPane";

/** A conversation to show, and the message to go to in it, if one was named. */
export interface SideOpen {
  tab: TabKey;
  message?: MessageId | null;
  /** A person opened from the list (#351): the next one takes this tab over until it's kept. */
  preview?: boolean;
}

/** What the list window may ask of the side while it's out. */
export interface SideHandle {
  open: (opening: SideOpen) => void;
  draftOf: (conversation: string) => string;
}

export interface SidePaneProps {
  /** The list window's own sign-ins: the side is in the owner, and borrows nothing. */
  apis: ReadonlyMap<string, AuthedApi>;
  /** What only the owner may do, asked of it directly (`Sharing.local`). */
  intend: (intent: Intent) => Promise<void>;
  /** The open tabs, conversations and Media or Search, kept by the list window so they outlast folding. */
  tabs: Tabs<SideTab>;
  setTabs: Dispatch<SetStateAction<Tabs<SideTab>>>;
  /** The conversation the side unfolded on, if it unfolded to show one. */
  first: SideOpen | null;
  /**
   * How the list window reaches the side while it's out: to show a
   * conversation, and to read a box's draft before its tab moves to a window
   * of its own. Called with the side's own; hand back a way to let it go.
   */
  bind: (side: SideHandle) => () => void;
  /** Show a conversation, as the list would: here, or in its own window, at a message if one is named. */
  show: (server: string, roomId: RoomId, messageId?: MessageId) => void;
  /** Changes when Search's box should get the cursor again (Ctrl+K). */
  searchAsk: number;
  /** Media's or Search's tab into a window of its own. */
  onPopOutTool: (which: "media" | "search") => void;
  /** Mute, Deafen and Leave on a voice line: the list window acts itself, as its voice bar does. */
  voiceControl: (press: VoiceControlQuestion) => void;
  /**
   * Fold back to just the list: the button at the conversations' own left
   * edge, which folding takes away, so a second click can't land on
   * whatever the list has there (its close button).
   */
  onFold: () => void;
  /** Linger's own close button for the list window, where the desktop draws none. */
  onClose?: () => void;
}

/**
 * Conversations beside the list (#337, docs/design/buddy-list.md,
 * "Conversations beside the list"): tabs, and the showing conversation, in
 * the list window itself. Drawn only while the list window is unfolded, so
 * it counts towards where you are, and holds back the chime for what you're
 * looking at, only while it's there to be seen.
 */
export function SidePane({ apis, intend, tabs, setTabs, first, bind, show, searchAsk, onPopOutTool, voiceControl, onFold, onClose }: SidePaneProps) {
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const findTab = useCallback((id: string): SideTab | undefined => tabsNow.current.open.find((tab) => keyOf(tab) === id), []);
  // A conversation's tab, for uploads that finish after their tab was left.
  const find = useCallback((id: string): TabKey | undefined => {
    const tab = findTab(id);
    return tab && !isTool(tab) ? tab : undefined;
  }, [findTab]);
  // A draft that came with the first conversation, back from a window of its own.
  const [firstSeed] = useState(() => {
    const store = draftStore();
    const text = store && first ? takeDraft(store, keyOf(first.tab), Date.now()) : null;
    return first && text !== null ? { conversation: keyOf(first.tab), text } : null;
  });
  const [firstMessage] = useState(() => (first?.message ? { tab: first.tab, id: first.message } : null));
  const active = tabs.active;
  const conversation = active && !isTool(active) ? active : null;
  const tool = active && isTool(active) ? active.tool : null;
  // Typing in a person's preview tab keeps it (#351).
  const onTyped = useCallback(
    (id: string) => {
      if (!isPreview(tabsNow.current, id)) return;
      setTabs((held) => {
        const tab = held.open.find((open) => keyOf(open) === id);
        return tab ? keepTab(held, tab) : held;
      });
    },
    [setTabs],
  );
  const view = useConversationPane({ apis, intend, active: conversation, find, show, firstSeed, firstMessage, voiceControl, onTyped });
  const { goToMessage, askFocus, seedDraft, draftOf, tabItem } = view;

  // A conversation opened while the side is out: to the message first, so
  // the room opens once, around it (#266), then its tab, and the cursor.
  const opened = useCallback(
    ({ tab, message, preview }: SideOpen) => {
      if (message) goToMessage(tab, message);
      setTabs((held) => (preview ? previewTab(held, tab) : openTab(held, tab)));
      askFocus();
      // Back from a window of its own, perhaps with a draft.
      const store = draftStore();
      const text = store ? takeDraft(store, keyOf(tab), Date.now()) : null;
      if (text !== null) seedDraft(keyOf(tab), text);
    },
    [goToMessage, setTabs, askFocus, seedDraft],
  );
  useEffect(() => bind({ open: opened, draftOf }), [bind, opened, draftOf]);

  // Presence: the list window's focus, the person moving in it, and the
  // conversation on show here, reported as the side (core/report.ts). Folded
  // away, it shows nothing, and says so.
  const reporter = useRef<Reporter | null>(null);
  useEffect(() => {
    const reporting = startReporting(intend, windowTarget());
    reporter.current = reporting;
    return () => {
      reporting.stop();
      if (reporter.current === reporting) reporter.current = null;
    };
  }, [intend]);
  // Media or Search shows no conversation: you're around, not in a room.
  const anyServer = apis.keys().next().value;
  useEffect(() => {
    if (conversation) reporter.current?.showing(conversation.server, conversation.roomId);
    else if (tool !== null && anyServer !== undefined) reporter.current?.showing(anyServer, null);
  }, [conversation, tool, anyServer]);

  // A tab into a window of its own: the owner opens windows, and the draft
  // goes along (core/handoff.ts).
  const popOut = useCallback(
    (id: string) => {
      const tab = findTab(id);
      if (!tab) return;
      if (isTool(tab)) onPopOutTool(tab.tool);
      else {
        const store = draftStore();
        if (store) leaveDraft(store, id, draftOf(id), Date.now());
        void intend({ kind: "popout", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
      }
      setTabs((held) => closeTab(held, tab));
    },
    [findTab, intend, draftOf, setTabs, onPopOutTool],
  );
  // A search hit or a media tile: its conversation, at the message, where conversations open.
  const onFound = useCallback<OpenFound>((server, roomId, messageId) => show(server, roomId, messageId), [show]);

  // Tab shortcuts (core/keys.ts), taken before the focused control sees
  // them, so they work from the message box too. Ctrl+, and Ctrl+K are the
  // list's, beside it or not.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  }, [setTabs]);

  const items = useMemo(
    () =>
      tabs.open.flatMap((tab): TabItem[] => {
        if (isTool(tab)) {
          const name = tab.tool === "media" ? "Media" : "Search";
          return [{ id: keyOf(tab), title: name, label: name, lead: { kind: "icon", icon: tab.tool }, closable: true }];
        }
        const item = tabItem(tab, same(tab, tabs.active));
        if (!item) return [];
        return [isPreview(tabs, keyOf(tab)) ? { ...item, preview: true, label: `${item.label}, preview` } : item];
      }),
    [tabs, tabItem],
  );

  return (
    <div className="nx-side" data-screen="side">
      <ChatView
        tabs={items}
        activeId={active ? keyOf(active) : null}
        onSelectTab={(id) => {
          const tab = findTab(id);
          if (tab) setTabs((held) => selectTab(held, tab));
        }}
        onCloseTab={(id) => {
          const tab = findTab(id);
          if (tab) setTabs((held) => closeTab(held, tab));
        }}
        onMoveTab={(id, to) => {
          const tab = findTab(id);
          if (tab) setTabs((held) => moveTab(held, tab, to));
        }}
        onPopOut={popOut}
        leading={<IconButton icon="fold" label="Fold back to your list" onClick={onFold} />}
        onCloseWindow={onClose}
        pane={view.pane}
        other={
          tool === "media"
            ? { id: keyOf({ tool }), label: "Media", body: <MediaPanel apis={apis} onOpen={onFound} /> }
            : tool === "search"
              ? { id: keyOf({ tool }), label: "Search", body: <SearchPanel apis={apis} onOpen={onFound} focusRequest={searchAsk} /> }
              : null
        }
      />
      {view.card}
    </div>
  );
}
