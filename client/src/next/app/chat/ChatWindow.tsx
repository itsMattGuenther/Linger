import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { ApiError, type AuthedApi, TransportError } from "../../../lib/api";
import { useNow } from "../../../lib/clock";
import { dmLabel } from "../../../lib/dm";
import { openExternal } from "../../../lib/external";
import {
  deleteMessage,
  editMessage,
  enterRoom,
  type GatewayState,
  leaveWindow,
  loadNewer,
  loadOlder,
  openAround,
  openRoom,
  releaseOtherRooms,
  sendMessage,
  serverState,
  startedTyping,
  trimHistory,
  useServers,
} from "../../../lib/gateway";
import { useLinkPreviews, wantPreviews } from "../../../lib/previews";
import { absoluteUrl } from "../../../lib/url";
import { uploadFile } from "../../../lib/upload";
import { PUSH_TO_TALK_KEY } from "../../../lib/voice";
import { tauriBus } from "../../core/bus";
import {
  conversationIn,
  dmPeople,
  openingAt,
  peopleInRoom,
  tabModel,
  typingIn,
  voiceHere,
} from "../../core/chat/conversation";
import { added, type Drafts, filesIn, NO_DRAFTS, progressed, refused, removed, restored, sent, taken, uploaded } from "../../core/chat/drafts";
import type { Submission } from "../../core/chat/sending";
import { voiceStrip } from "../../core/chat/voice";
import { type Following, followOwner } from "../../core/mirror";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { closeTab, keepOnly, keyOf, loadTabs, openTab, saveTabs, selectTab, type TabKey, type Tabs } from "../../core/tabs";
import { talkingNow } from "../../core/voice";
import { markerOf, Spinner, type TabItem } from "../../kit";
import { WindowMessage } from "../WindowMessage";
import { type ChatPane, ChatView } from "./ChatView";

/** Open tabs and their order, on this computer (docs/design/architecture.md, "Remembering"). */
const TABS_KEY = "linger.next.tabs";
/** How long a knock's button says "Knocked" (SPEC §4.9), as on the person card. */
const KNOCKED_MS = 3_000;
/** "Typing…" goes a few seconds after the last keystroke (`TYPING_TTL_MS`); checked this often. */
const TYPING_CHECK_MS = 2_000;
const NO_MESSAGES: readonly Message[] = [];
const NO_PEOPLE: ReadonlyMap<string, User> = new Map();

/**
 * One follow per page. The window lives as long as the page, and following
 * twice (React's StrictMode runs effects twice) would register the same
 * server twice in the store.
 */
let started: Promise<Following> | null = null;
function followOnce(): Promise<Following> {
  started ??= followOwner(tauriBus());
  return started;
}

/**
 * The chat window: a viewer (docs/design/architecture.md, "Windows and their
 * roles"). It catches up with the list window's connection and follows it,
 * shows conversations in tabs, and asks the list window for what only the
 * owner may do: marking read, placing you in a room, and voice.
 */
export function ChatWindow() {
  const [held, setHeld] = useState<{ kind: "waiting" } | { kind: "lost" } | { kind: "ready"; following: Following }>({ kind: "waiting" });
  useEffect(() => {
    let alive = true;
    followOnce().then(
      (following) => alive && setHeld({ kind: "ready", following }),
      () => alive && setHeld({ kind: "lost" }),
    );
    return () => {
      alive = false;
    };
  }, []);

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
      </WindowMessage>
    );
  }
  return <Conversations following={held.following} />;
}

/** The tabs this window starts with: the ones remembered, and the one it was opened on. */
function firstTabs(apis: ReadonlyMap<string, AuthedApi>): Tabs {
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(TABS_KEY);
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
  // Bumped when the window should put the cursor in the box: it opened, or a
  // conversation was opened from the list.
  const [focusAsk, setFocusAsk] = useState(1);
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const [knocked, setKnocked] = useState<ReadonlySet<string>>(new Set());
  const reporter = useRef<Reporter | null>(null);

  // Opened from the list while this window is already open (window.rs, `next_open_chat`).
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<{ server: string; room: string }>("next:open", ({ server, room }) => {
        if (!apis.has(server)) return;
        setTabs((held) => openTab(held, { server, roomId: room }));
        setFocusAsk((ask) => ask + 1);
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [apis]);

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

  // A window with no conversations left has nothing to show: it closes.
  const empty = tabs.open.length === 0;
  useEffect(() => {
    if (empty) closeWindow();
  }, [empty, closeWindow]);

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

  const items = useMemo(
    () =>
      tabs.open.flatMap((tab): TabItem[] => {
        const state = servers[tab.server];
        const model = state ? tabModel(tab, state, sameTab(tab, tabs.active), talkingNow(state)) : null;
        if (!model) return [];
        return [
          {
            id: model.id,
            title: model.title,
            label: model.label,
            lead: model.lead === null ? undefined : model.lead.kind === "room" ? { kind: "room" } : { kind: "person", person: markerOf(model.lead.user, model.lead.state) },
            fresh: model.fresh,
            voice: model.voice ?? undefined,
            speaking: model.speaking,
            closable: true,
          },
        ];
      }),
    [tabs, servers],
  );

  const find = useCallback((id: string): TabKey | undefined => tabsNow.current.open.find((tab) => keyOf(tab) === id), []);

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

  // Files, per conversation, uploading on their own (core/chat/drafts.ts).
  const onAttach = useCallback(
    (chosen: File[]) => {
      if (!api || paneId === null) return;
      const files = chosen.map((file) => ({ file, key: `${paneId} ${file.name} ${Date.now()} ${Math.random()}` }));
      setDrafts((held) => added(held, paneId, files.map(({ key, file }) => ({ key, name: file.name }))));
      for (const { file, key } of files) {
        uploadFile(api, file, { onProgress: (fraction) => setDrafts((held) => progressed(held, key, fraction)) }).then(
          (attachment) => setDrafts((held) => uploaded(held, key, attachment)),
          (error: unknown) => setDrafts((held) => refused(held, key, error instanceof ApiError ? error.message : "That file didn't go up.")),
        );
      }
    },
    [api, paneId],
  );
  const onRemoveFile = useCallback(
    (key: string) => {
      const { drafts: next, abandoned } = removed(draftsNow.current, key);
      setDrafts(next);
      // A finished upload nothing will point at: give the server its space back.
      if (abandoned && api) void api.cancelUpload(String(abandoned.id)).catch(() => undefined);
    },
    [api],
  );
  const onRestoreFiles = useCallback((keys: string[]) => setDrafts((held) => restored(held, keys)), []);

  const onSend = useCallback(
    async (submission: Submission) => {
      const tab = find(submission.conversation);
      const sendApi = tab ? apis.get(tab.server) : undefined;
      if (!tab || !sendApi) throw new Error("That conversation is closed. Your message is kept here.");
      const taking = taken(draftsNow.current, submission.conversation, submission.fileKeys);
      if (taking === null) throw new Error("A file is still uploading. Your message is kept here.");
      setDrafts(taking.drafts);
      draftsNow.current = taking.drafts;
      try {
        await sendMessage(sendApi, tab.roomId, submission.body, submission.replyTo, taking.attachments);
      } catch (error: unknown) {
        throw new Error(error instanceof ApiError ? error.message : "Couldn't reach the server. Your message is kept here.");
      }
      setDrafts((held) => sent(held, submission.fileKeys));
    },
    [apis, find],
  );
  const onTyping = useCallback(() => {
    if (api && roomId !== null) startedTyping(api, roomId);
  }, [api, roomId]);
  const composer = useMemo(
    () => ({ files: paneId === null ? [] : filesIn(drafts, paneId), onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusRequest: focusAsk }),
    [drafts, paneId, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusAsk],
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
        }
      : { kind: "room", name: room.name, topic: room.topic, people: peopleInRoom(state, room.id) };
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
      onCloseWindow={isTauri() ? closeWindow : undefined}
      pane={pane}
    />
  );
}

function sameTab(a: TabKey, b: TabKey | null): boolean {
  return b !== null && a.server === b.server && a.roomId === b.roomId;
}

/** A store or network failure, as a sentence for the message it was about. */
function rethrowInWords(fallback: string): (error: unknown) => never {
  return (error: unknown) => {
    throw new Error(error instanceof ApiError || error instanceof TransportError ? error.message : fallback);
  };
}

/**
 * Walking into a conversation, as today's client does (`stream/Stream.tsx`):
 * pin the "you left off here" line, let go of other rooms' scrollback (#173),
 * and load the history around where you left off, or the newest. Once per
 * visit, after the read positions are in; again after a reconnect, which may
 * have made the loaded history stale.
 */
function useLanding(api: AuthedApi | null, roomId: RoomId | null, state: GatewayState | null): { ready: boolean; at: "left-off" | "end" } {
  const readLoaded = state?.readLoaded ?? false;
  const sessionId = state?.sessionId ?? null;
  const key = api && roomId !== null ? `${api.baseUrl}#${roomId}` : "";
  const [land, setLand] = useState<{ key: string; ready: boolean; at: "left-off" | "end" }>({ key: "", ready: false, at: "end" });

  useEffect(() => {
    if (!api || roomId === null || !readLoaded) return;
    const server = api.baseUrl;
    const here = `${server}#${roomId}`;
    let alive = true;
    const current = serverState(server);
    const target = openingAt(current, roomId);
    const stream = current.streams[roomId];
    enterRoom(server, roomId);
    releaseOtherRooms(server, roomId);
    setLand({ key: here, ready: false, at: target === null ? "end" : "left-off" });
    void (async () => {
      if (target !== null) await openAround(api, roomId, target);
      else if (stream && !stream.atEnd) await leaveWindow(api, roomId);
      else await openRoom(api, roomId);
      if (alive) setLand({ key: here, ready: true, at: target === null ? "end" : "left-off" });
    })();
    return () => {
      alive = false;
    };
  }, [api, roomId, readLoaded, sessionId]);

  const ready = land.key === key && land.ready;
  const at = land.key === key ? land.at : "end";
  // One object per change, so the conversation isn't redrawn by every update to the store.
  return useMemo(() => ({ ready, at }), [ready, at]);
}

/**
 * You have read what you can see: the newest message is on screen, the
 * conversation is at its end, and this window has your attention. A
 * conversation open on a second screen while you type elsewhere hasn't been
 * read, and marking it would eat the line that says where you stopped. The
 * owner keeps read positions, so this asks it (core/share.ts, "read").
 */
function useReading(
  intend: Following["intend"],
  active: TabKey | null,
  state: GatewayState | null,
  landed: boolean,
): (id: MessageId) => void {
  const seen = useRef<{ tab: string; id: MessageId } | null>(null);
  // What was last asked for, so the owner hears each position once.
  const asked = useRef<{ tab: string; id: MessageId } | null>(null);
  const atEnd = active && state ? (state.streams[active.roomId]?.atEnd ?? false) : false;
  const tab = active ? keyOf(active) : "";

  const mark = useCallback(() => {
    const newest = seen.current;
    if (!active || !newest || newest.tab !== tab || !landed || !atEnd) return;
    if (!document.hasFocus() || document.visibilityState !== "visible") return;
    if (asked.current?.tab === tab && asked.current.id === newest.id) return;
    asked.current = newest;
    void intend({ kind: "read", server: active.server, roomId: active.roomId, messageId: newest.id }).catch(() => undefined);
  }, [active, tab, landed, atEnd, intend]);
  const markNow = useRef(mark);
  markNow.current = mark;

  // Coming back to the window with the newest message on screen is reading it.
  useEffect(() => {
    const onFocus = () => markNow.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return useCallback(
    (id: MessageId) => {
      seen.current = { tab, id };
      markNow.current();
    },
    [tab],
  );
}
