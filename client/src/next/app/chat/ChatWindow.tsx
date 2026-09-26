import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { ApiError, type AuthedApi, TransportError } from "../../../lib/api";
import { useNow } from "../../../lib/clock";
import { dmLabel } from "../../../lib/dm";
import { openExternal } from "../../../lib/external";
import { deleteMessage, editMessage, leaveWindow, loadNewer, loadOlder, startedTyping, trimHistory, useServers } from "../../../lib/gateway";
import { useLinkPreviews, wantPreviews } from "../../../lib/previews";
import { absoluteUrl } from "../../../lib/url";
import { PUSH_TO_TALK_KEY } from "../../../lib/voice";
import { ask, OWNER, PROTOCOL, tauriBus } from "../../core/bus";
import {
  conversationIn,
  dmPeople,
  peopleInRoom,
  tabModel,
  typingIn,
  voiceHere,
} from "../../core/chat/conversation";
import { leaveDraft, takeDraft } from "../../core/handoff";
import { voiceStrip } from "../../core/chat/voice";
import { isSettingsKey, tabCommand } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { MODE, type ModeMessage, OPENS, type OpensAnswer } from "../../core/share";
import { closeTab, keepOnly, keyOf, loadTabs, moveTab, openTab, same, saveTabs, selectTab, stepTab, type TabKey, type Tabs } from "../../core/tabs";
import { talkingNow } from "../../core/voice";
import { Button, markerOf, Spinner, type TabItem } from "../../kit";
import { useFollowing } from "../useFollowing";
import { hostOf, useServerInfos } from "../useServerInfos";
import { WindowMessage } from "../WindowMessage";
import { type ChatPane, ChatView } from "./ChatView";
import { useFileDrafts } from "./useFileDrafts";
import { useLanding, useReading } from "./visit";

/** Open tabs and their order, on this computer (docs/design/architecture.md, "Remembering"). */
const TABS_KEY = "linger.next.tabs";
/** How long a knock's button says "Knocked" (SPEC §4.9), as on the person card. */
const KNOCKED_MS = 3_000;
/** "Typing…" goes a few seconds after the last keystroke (`TYPING_TTL_MS`); checked this often. */
const TYPING_CHECK_MS = 2_000;
const NO_MESSAGES: readonly Message[] = [];
const NO_PEOPLE: ReadonlyMap<string, User> = new Map();

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

/** Where drafts wait while their conversation moves between windows (core/handoff.ts). */
function handoffStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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

function Conversations({ following }: { following: Following }) {
  const { apis, intend } = following;
  const servers = useServers();
  const now = useNow();
  // Its own clock, so the conversation isn't redrawn every two seconds.
  const typingNow = useNow(TYPING_CHECK_MS);
  const [tabs, setTabs] = useState<Tabs>(() => firstTabs(apis));
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const find = useCallback((id: string): TabKey | undefined => tabsNow.current.open.find((tab) => keyOf(tab) === id), []);
  // Bumped when the window should put the cursor in the box: it opened, or a
  // conversation was opened from the list.
  const [focusAsk, setFocusAsk] = useState(1);
  const [knocked, setKnocked] = useState<ReadonlySet<string>>(new Set());
  const reporter = useRef<Reporter | null>(null);
  const intendNow = useRef(intend);
  intendNow.current = intend;
  // What each conversation's box holds, so a draft can go with it to another window.
  const typed = useRef(new Map<string, string>());
  const onDraft = useCallback((conversation: string, text: string) => void typed.current.set(conversation, text), []);
  // A draft that came with a conversation from another window.
  const [seed, setSeed] = useState<{ conversation: string; text: string } | null>(() => {
    const store = handoffStore();
    const first = tabs.active;
    const text = store && first ? takeDraft(store, keyOf(first), Date.now()) : null;
    return first && text !== null ? { conversation: keyOf(first), text } : null;
  });

  // Opened from the list while this window is already open (window.rs,
  // `next_open_chat`). Once listening, the tabs window asks the list window
  // for anything it was sent before it was (OPENS in core/share.ts).
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    const opened = (server: string, roomId: string) => {
      if (!apis.has(server)) return;
      const tab = { server, roomId };
      setTabs((held) => openTab(held, tab));
      setFocusAsk((ask) => ask + 1);
      // Back from a window of its own, perhaps with a draft.
      const store = handoffStore();
      const text = store ? takeDraft(store, keyOf(tab), Date.now()) : null;
      if (text !== null) setSeed({ conversation: keyOf(tab), text });
    };
    const bus = tauriBus();
    void bus
      .listen<{ server: string; room: string }>("next:open", ({ server, room }) => opened(server, room))
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
            for (const { server, roomId } of opens) opened(server, roomId);
          })
          .catch(() => undefined);
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [apis]);

  // A server signed out of takes its tabs with it; with none left, the
  // window closes.
  useEffect(() => following.onSignedOut((server) => setTabs((held) => keepOnly(held, (tab) => tab.server !== server))), [following]);

  // A conversation that's gone (a room archived, a DM you were taken out of)
  // loses its tab, once its server has told this window what exists.
  useEffect(() => {
    setTabs((held) =>
      keepOnly(held, (tab) => {
        const state = servers[tab.server];
        return state === undefined || state.me === null || conversationIn(state, tab.roomId) !== null;
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
  const active = tabs.active;
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
      const store = handoffStore();
      if (!tab) return;
      if (store) leaveDraft(store, id, typed.current.get(id) ?? "", Date.now());
      void intend({ kind: "popout", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
      setTabs((held) => closeTab(held, tab));
    },
    [find, intend],
  );
  const backToTabs = useCallback(() => {
    const tab = tabsNow.current.active;
    const store = handoffStore();
    if (!tab) return;
    if (store) leaveDraft(store, keyOf(tab), typed.current.get(keyOf(tab)) ?? "", Date.now());
    void intend({ kind: "tabs", server: tab.server, roomId: tab.roomId }).catch(() => undefined);
    closeWindow();
  }, [intend, closeWindow]);

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
    const store = handoffStore();
    for (const tab of [...open.filter((held) => !same(held, active)), ...open.filter((held) => same(held, active))]) {
      if (store) leaveDraft(store, keyOf(tab), typed.current.get(keyOf(tab)) ?? "", Date.now());
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
      if (event.key === PUSH_TO_TALK_KEY && !event.repeat) say(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === PUSH_TO_TALK_KEY) say(false);
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

  // Where your voice seat is, as a tab id, on whichever server has it.
  const voiceTab = useMemo(() => {
    for (const [server, state] of Object.entries(servers)) {
      if (state.myVoice) return keyOf({ server, roomId: state.myVoice.roomId });
    }
    return null;
  }, [servers]);

  // With several servers every conversation says where it's from: a stripe
  // on its tab in the server's color, and its name in the header (MULTI-6).
  const infos = useServerInfos(apis);
  const several = apis.size > 1;
  const serverTag = useCallback(
    (server: string) => ({ name: infos[server]?.name ?? hostOf(server), color: infos[server]?.accent ?? "slate" }),
    [infos],
  );

  const items = useMemo(
    () =>
      tabs.open.flatMap((tab): TabItem[] => {
        const state = servers[tab.server];
        const model = state ? tabModel(tab, state, same(tab, tabs.active), talkingNow(state)) : null;
        if (!model) return [];
        return [
          {
            id: model.id,
            title: model.title,
            label: several ? `${model.label}, ${serverTag(tab.server).name}` : model.label,
            stripe: several ? serverTag(tab.server).color : undefined,
            lead: model.lead === null ? undefined : model.lead.kind === "room" ? { kind: "room" } : { kind: "person", person: markerOf(model.lead.user, model.lead.state) },
            fresh: model.fresh,
            voice: model.voice ?? undefined,
            speaking: model.speaking,
            closable: true,
          },
        ];
      }),
    [tabs, servers, several, serverTag],
  );


  // ------------------------------------------------------------------
  // The showing conversation.

  const api = active ? (apis.get(active.server) ?? null) : null;
  const state = active ? (servers[active.server] ?? null) : null;
  const roomId = active?.roomId ?? null;
  const room = state && roomId !== null ? conversationIn(state, roomId) : null;
  const paneId = active ? keyOf(active) : null;

  const land = useLanding(api, roomId, state);
  const read = useReading(intend, active, state, land.ready);

  const stream = state && roomId !== null ? state.streams[roomId] : undefined;
  const messages = stream?.messages ?? NO_MESSAGES;
  const pending = useMemo(() => stream?.pending.map((one) => one.message) ?? NO_MESSAGES, [stream?.pending]);
  const people = useMemo(() => (state ? new Map(state.users.map((user) => [user.id, user])) : NO_PEOPLE), [state?.users]);
  const talking = useMemo(() => (state ? talkingNow(state) : new Set<string>()), [state]);
  const previews = useLinkPreviews(active?.server ?? "");

  const onNearStart = useCallback(() => {
    if (api && roomId !== null) void loadOlder(api, roomId);
  }, [api, roomId]);
  const onNearEnd = useCallback(() => {
    if (api && roomId !== null) void loadNewer(api, roomId);
  }, [api, roomId]);
  const onLetGo = useCallback(
    (first: MessageId, last: MessageId) => {
      if (api && roomId !== null) trimHistory(api.baseUrl, roomId, first, last);
    },
    [api, roomId],
  );
  const onBackToNewest = useCallback(() => {
    if (api && roomId !== null) void leaveWindow(api, roomId);
  }, [api, roomId]);
  const mediaUrl = useCallback((path: string) => (api ? absoluteUrl(api.baseUrl, path) : path), [api]);

  const save = useCallback(
    async (message: Message, body: string) => {
      if (!api) throw new Error("This conversation isn't connected.");
      await editMessage(api, message, body).catch(rethrowInWords("Couldn't save the edit."));
    },
    [api],
  );
  const remove = useCallback(
    async (message: Message) => {
      if (!api) throw new Error("This conversation isn't connected.");
      await deleteMessage(api, message).catch(rethrowInWords("Couldn't delete it."));
    },
    [api],
  );
  const download = useCallback((file: Attachment) => openExternal(mediaUrl(file.url)), [mediaUrl]);
  const wantCards = useCallback(
    (urls: readonly string[]) => {
      if (api) wantPreviews(api, [...urls]);
    },
    [api],
  );
  const actions = useMemo(() => ({ save, remove, openLink: openExternal, download, wantCards }), [save, remove, download, wantCards]);

  const { files, onAttach, onRemoveFile, onRestoreFiles, onSend } = useFileDrafts(api, paneId, apis, find);
  const onTyping = useCallback(() => {
    if (api && roomId !== null) startedTyping(api, roomId);
  }, [api, roomId]);
  const composer = useMemo(
    () => ({ files, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusRequest: focusAsk, seed, onDraft }),
    [files, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusAsk, seed, onDraft],
  );

  const knock = useCallback(
    (user: User) => {
      if (!api) return;
      const done = () =>
        setKnocked((held) => {
          const next = new Set(held);
          next.delete(user.id);
          return next;
        });
      setKnocked((held) => new Set(held).add(user.id));
      window.setTimeout(done, KNOCKED_MS);
      // A refused knock (three an hour, SPEC §4.9) doesn't get to say "Knocked".
      void api.knock(user.id).catch(done);
    },
    [api],
  );

  const onJoin = useCallback(() => {
    if (active) void intend({ kind: "voice.join", server: active.server, roomId: active.roomId }).catch(() => undefined);
  }, [active, intend]);

  const pane = ((): ChatPane | null => {
    if (!active || !state || !room || paneId === null) return null;
    const dm = room.kind === "dm";
    const others = dm ? dmPeople(state, room) : [];
    const [only] = others;
    const header: ChatPane["header"] = dm
      ? {
          kind: "dm",
          label: dmLabel(room, state.users, state.me?.id ?? null),
          people: others,
          onKnock: others.length === 1 && only && only.state !== "offline" ? () => knock(only.user) : undefined,
          knocked: only ? knocked.has(only.user.id) : false,
          server: several ? serverTag(active.server) : undefined,
        }
      : { kind: "room", name: room.name, topic: room.topic, people: peopleInRoom(state, room.id), server: several ? serverTag(active.server) : undefined };
    return {
      id: paneId,
      header,
      voice: { strip: voiceStrip(paneId, voiceHere(state, room.id), state.me?.id ?? null, voiceTab), onJoin },
      people,
      me: state.me,
      speaking: talking,
      typing: typingIn(state, room.id, typingNow),
      stream: {
        messages,
        pending,
        atStart: stream?.atStart ?? false,
        atEnd: stream?.atEnd ?? true,
        leftOff: state.leftOff[room.id] ?? null,
        land,
        now,
        previews,
        mediaUrl,
        onNearStart,
        onNearEnd,
        onSeenNewest: read,
        onLetGo,
        onBackToNewest,
      },
      actions,
      composer,
    };
  })();

  if (empty) return null;

  return (
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
      pane={pane}
    />
  );
}

/** A store or network failure, as a sentence for the message it was about. */
function rethrowInWords(fallback: string): (error: unknown) => never {
  return (error: unknown) => {
    throw new Error(error instanceof ApiError || error instanceof TransportError ? error.message : fallback);
  };
}
