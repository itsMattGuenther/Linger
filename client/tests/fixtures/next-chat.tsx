/**
 * The chat window, drawn from the prototype's Friday evening
 * (`next/evening.ts`) with no server and no desktop shell. The window's
 * rules are unit-tested in `src/next/core/chat/`; this page is for looking
 * at the views and for `tests/browser/next-chat.spec.ts` to measure.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-chat.html. The
 * window is the prototype's chat window size: 780 wide by 790 tall.
 *
 * - `?tab=r-listening` (or `d-jules`, `r-plans`): which tab shows first.
 * - `?voice=mine`: you're in voice in #general. `elsewhere`: you're in voice
 *   in #listening-room. `off`: nobody is in voice anywhere.
 * - `?big`: #general holds 5,000 messages, all at once. `&paged`: loaded
 *   150 at a time from the newest, as the store pages them.
 * - `?fail`: every send is refused.
 * - `?long`: Eli has a name far too long for its place.
 *
 * `window.chat` lets a test make things happen: a message arriving, someone
 * typing. What the page was asked to do is written to `body[data-did]`.
 */
import { StrictMode, useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "../../src/generated/Message";
import type { MessageId } from "../../src/generated/MessageId";
import type { PresenceState } from "../../src/generated/PresenceState";
import type { Room } from "../../src/generated/Room";
import type { User } from "../../src/generated/User";
import { type ChatPane, ChatView } from "../../src/next/app/chat/ChatView";
import type { DraftFile } from "../../src/next/app/chat/Composer";
import type { Submission } from "../../src/next/core/chat/sending";
import { voiceStrip } from "../../src/next/core/chat/voice";
import { closeTab, keyOf, openTab, selectTab, type TabKey, type Tabs } from "../../src/next/core/tabs";
import { markerOf, type TabItem } from "../../src/next/kit";
import "../../src/next/styles/app.css";
import { NOW, SERVER, dms, leftOff, messages as evening, people, previews, rooms } from "./next/evening";

const query = new URLSearchParams(location.search);
const BIG = query.has("big");
const PAGED = BIG && query.has("paged");
const FAIL = query.has("fail");
const VOICE = query.get("voice") ?? "others";
const PAGE = 150;

const LONG = query.has("long");
const everyone: ReadonlyMap<string, User> = new Map(
  Object.values(people).map((user) => [
    user.id,
    LONG && user.id === "u-eli" ? { ...user, display_name: "Eli Bartholomew-Maximilian the Considerably Long" } : user,
  ]),
);
const me = people.matt;
const byRoom = new Map([rooms.general, rooms.listening, rooms.plans, dms.jules, dms.eliSam].map((room) => [room.id, room]));
const tabOf = (roomId: string): TabKey => ({ server: SERVER, roomId });

/** Who's in each room, and who's in voice there, as the evening has it. */
const IN_ROOM: Record<string, string[]> = { "r-general": ["u-matt", "u-eli", "u-jules"], "r-listening": ["u-dave"] };
const inVoice = (roomId: string): string[] => {
  if (VOICE === "off") return [];
  const others = roomId === "r-general" ? ["u-eli", "u-jules"] : [];
  const mine = (VOICE === "mine" && roomId === "r-general") || (VOICE === "elsewhere" && roomId === "r-listening");
  return mine ? ["u-matt", ...others] : others;
};
const myVoice = VOICE === "mine" ? keyOf(tabOf("r-general")) : VOICE === "elsewhere" ? keyOf(tabOf("r-listening")) : null;
const SPEAKING: ReadonlySet<string> = new Set(VOICE === "off" ? [] : ["u-eli"]);

/** Five thousand messages over many evenings: long enough that only virtualization keeps it quick. */
function bigRoom(): Message[] {
  const lines = [
    "anyone up?",
    "just got back from the store, the good bread was there for once",
    "ok this is the album. front to back, no skipping, I mean it this time",
    "the porch light is flickering again and I refuse to believe it's the bulb",
    "lol",
    "Saturday still on? I can bring the thermos and the folding chairs if we're sitting out by the water for a while.",
    "sounds good",
    "the cat has claimed the speaker. the speaker is the cat's now",
  ];
  const cast = [people.eli, people.jules, people.dave, people.callie, people.sam, people.matt];
  const out: Message[] = [];
  let at = NOW - 5000 * 4 * 60_000;
  for (let index = 0; index < 5000; index += 1) {
    at += index % 40 === 0 ? 5 * 3_600_000 : ((index * 7) % 5) * 60_000 + 30_000;
    const author = cast[Math.floor(index / 3) % cast.length] ?? people.eli;
    out.push({
      id: `b${String(index).padStart(6, "0")}`,
      room_id: "r-general",
      author_id: author.id,
      body: `${lines[index % lines.length] ?? "hi"} (${index + 1})`,
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: Math.min(at, NOW - 60_000),
    });
  }
  return out;
}

const ALL: Record<string, Message[]> = { ...evening, ...(BIG ? { "r-general": bigRoom() } : {}) };

declare global {
  interface Window {
    chat?: {
      /** A message arrives in a room, as if someone just said it. */
      arrive: (roomId: string, authorId: string, body: string) => void;
      /** Who is typing in a room. */
      typing: (roomId: string, userIds: string[]) => void;
    };
  }
}

const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};

interface Held {
  messages: Message[];
  /** Where the held window starts in `ALL` (paging, for `?big`). */
  from: number;
}

function Fixture() {
  const [tabs, setTabs] = useState<Tabs>(() => {
    let next: Tabs = { open: [], active: null };
    for (const id of ["r-general", "r-listening", "d-jules", "r-plans"]) next = openTab(next, tabOf(id));
    return selectTab(next, tabOf(query.get("tab") ?? "r-general"));
  });
  const [held, setHeld] = useState<Record<string, Held>>(() =>
    Object.fromEntries(
      Object.entries(ALL).map(([id, list]) => {
        const from = PAGED && id === "r-general" ? list.length - PAGE : 0;
        return [id, { messages: list.slice(from), from }];
      }),
    ),
  );
  const [pending, setPending] = useState<Record<string, Message[]>>({});
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set(["d-jules", "r-plans"]));
  const [typing, setTyping] = useState<Record<string, string[]>>({ "r-listening": ["u-dave"] });
  const [files, setFiles] = useState<Record<string, DraftFile[]>>({});
  const serial = useRef(0);
  const loading = useRef(false);

  const activeRoom = tabs.active?.roomId ?? null;
  const activeRef = useRef(activeRoom);
  activeRef.current = activeRoom;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const find = useCallback((id: string): TabKey | undefined => tabsRef.current.open.find((tab) => keyOf(tab) === id), []);

  const arrive = useCallback((roomId: string, message: Message) => {
    setHeld((all) => {
      const room = all[roomId] ?? { messages: [], from: 0 };
      return { ...all, [roomId]: { ...room, messages: [...room.messages, message] } };
    });
    if (roomId !== activeRef.current) setFresh((set) => new Set(set).add(roomId));
  }, []);

  window.chat = {
    arrive: (roomId, authorId, body) => {
      serial.current += 1;
      arrive(roomId, {
        id: `x${String(serial.current).padStart(6, "0")}`,
        room_id: roomId,
        author_id: authorId,
        body,
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned_at: null,
        edited_at: null,
        deleted_at: null,
        created_at: NOW,
      });
    },
    typing: (roomId, userIds) => setTyping((all) => ({ ...all, [roomId]: userIds })),
  };

  const items: TabItem[] = tabs.open.map((tab) => {
    const room = byRoom.get(tab.roomId);
    const voice = inVoice(tab.roomId);
    const mine = myVoice === keyOf(tab);
    const dm = room?.kind === "dm" ? dmPeople(room) : [];
    const [only] = dm;
    return {
      id: keyOf(tab),
      title: room?.kind === "dm" ? dmLabel(room) : (room?.name ?? "?"),
      label: room?.kind === "dm" ? `DM with ${dmLabel(room)}` : `#${room?.name ?? "?"}`,
      lead: room?.kind !== "dm" ? { kind: "room" } : dm.length === 1 && only ? { kind: "person", person: markerOf(only, stateOf(only)) } : undefined,
      fresh: fresh.has(tab.roomId),
      voice: mine ? "mine" : voice.length > 0 ? "others" : undefined,
      speaking: voice.some((id) => SPEAKING.has(id)),
      closable: true,
    };
  });

  const save = useCallback(async (message: Message, body: string) => {
    note(`save:${message.id}:${body}`);
    setHeld((all) => edit(all, message, { body, edited_at: NOW }));
  }, []);
  const remove = useCallback(async (message: Message) => {
    note(`delete:${message.id}`);
    setHeld((all) => edit(all, message, { body: "", deleted_at: NOW }));
  }, []);
  const openLink = useCallback((href: string) => note(`link:${href}`), []);
  const download = useCallback((file: { filename: string }) => note(`download:${file.filename}`), []);
  const actions = useMemo(() => ({ save, remove, openLink, download }), [save, remove, openLink, download]);

  const onNearStart = useCallback(() => {
    const roomId = activeRef.current;
    if (roomId === null || loading.current) return;
    loading.current = true;
    note(`older:${roomId}`);
    // A beat of network, then the page before arrives above.
    window.setTimeout(() => {
      loading.current = false;
      setHeld((all) => {
        const room = all[roomId];
        const source = ALL[roomId];
        if (!room || !source || room.from === 0) return all;
        const from = Math.max(0, room.from - PAGE);
        return { ...all, [roomId]: { messages: [...source.slice(from, room.from), ...room.messages], from } };
      });
    }, 60);
  }, []);
  const onNearEnd = useCallback(() => undefined, []);
  const onSeenNewest = useCallback((id: MessageId) => {
    if (document.body.dataset.seen !== id) document.body.dataset.seen = id;
  }, []);
  const onLetGo = useCallback(() => undefined, []);
  const onBackToNewest = useCallback(() => note("newest"), []);
  const mediaUrl = useCallback((path: string) => (path.startsWith("data:") ? path : `${SERVER}${path}`), []);

  const onSend = useCallback(async (submission: Submission) => {
    const roomId = find(submission.conversation)?.roomId;
    if (!roomId) throw new Error("That conversation is closed.");
    note(`send:${submission.body}`);
    const draft: Message = {
      id: `p${submission.key}`,
      room_id: roomId,
      author_id: me.id,
      body: submission.body,
      reply_to: submission.replyTo,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: NOW,
    };
    setPending((all) => ({ ...all, [roomId]: [...(all[roomId] ?? []), draft] }));
    await new Promise((settle) => window.setTimeout(settle, FAIL ? 120 : 40));
    setPending((all) => ({ ...all, [roomId]: (all[roomId] ?? []).filter((one) => one.id !== draft.id) }));
    if (FAIL) throw new Error("Couldn't reach the server. Your message is kept here.");
    arrive(roomId, { ...draft, id: `s${submission.key}` });
  }, [arrive, find]);

  const onAttach = useCallback((chosen: File[]) => {
    const roomId = activeRef.current;
    if (roomId === null) return;
    setFiles((all) => ({
      ...all,
      [roomId]: [
        ...(all[roomId] ?? []),
        ...chosen.map((file, index) => ({ key: `f${Date.now()}-${index}`, name: file.name, progress: 1, ready: true, problem: null })),
      ],
    }));
  }, []);
  const onRemoveFile = useCallback((key: string) => {
    const roomId = activeRef.current;
    if (roomId !== null) setFiles((all) => ({ ...all, [roomId]: (all[roomId] ?? []).filter((file) => file.key !== key) }));
  }, []);
  const onRestoreFiles = useCallback(() => undefined, []);
  const onTyping = useCallback(() => undefined, []);
  const onJoin = useCallback(() => note("join"), []);

  const pane = ((): ChatPane | null => {
    if (!tabs.active || activeRoom === null) return null;
    const room = byRoom.get(activeRoom);
    if (!room) return null;
    const id = keyOf(tabs.active);
    const mine = held[activeRoom] ?? { messages: [], from: 0 };
    const voice = inVoice(activeRoom);
    return {
      id,
      header:
        room.kind === "dm"
          ? {
              kind: "dm",
              label: dmLabel(room),
              people: dmPeople(room).map((user) => ({ user, state: stateOf(user) })),
              onKnock: dmPeople(room).length === 1 ? () => note("knock") : undefined,
            }
          : { kind: "room", name: room.name, topic: room.topic, people: (IN_ROOM[room.id] ?? []).flatMap((one) => everyone.get(one) ?? []) },
      voice: room.kind === "dm" ? null : { strip: voiceStrip(id, voice, me.id, myVoice), onJoin },
      people: everyone,
      me,
      speaking: SPEAKING,
      typing: (typing[activeRoom] ?? []).flatMap((one) => everyone.get(one) ?? []),
      stream: {
        messages: mine.messages,
        pending: pending[activeRoom] ?? EMPTY,
        atStart: mine.from === 0,
        atEnd: true,
        leftOff: leftOff[activeRoom] ?? null,
        land: { ready: true, at: leftOff[activeRoom] ? "left-off" : "end" },
        now: NOW,
        previews,
        mediaUrl,
        onNearStart,
        onNearEnd,
        onSeenNewest,
        onLetGo,
        onBackToNewest,
      },
      actions,
      composer: { files: files[activeRoom] ?? NO_FILES, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping },
    };
  })();

  return (
    <ChatView
      tabs={items}
      activeId={tabs.active ? keyOf(tabs.active) : null}
      onSelectTab={(id) => {
        const tab = find(id);
        if (!tab) return;
        setTabs((now) => selectTab(now, tab));
        setFresh((set) => {
          const next = new Set(set);
          next.delete(tab.roomId);
          return next;
        });
      }}
      onCloseTab={(id) => {
        const tab = find(id);
        if (tab) setTabs((now) => closeTab(now, tab));
      }}
      onPopOut={(id) => note(`popout:${id}`)}
      onCloseWindow={() => note("close")}
      pane={pane}
    />
  );
}

const EMPTY: Message[] = [];
const NO_FILES: DraftFile[] = [];

/** Presence as the evening has it. */
function stateOf(user: User): PresenceState {
  return user.id === "u-sam" ? "away" : user.id === "u-callie" ? "around" : user.id === "u-jen" ? "offline" : "in_room";
}

function dmPeople(room: Room): User[] {
  return (room.member_ids ?? []).filter((id) => id !== me.id).flatMap((id) => everyone.get(id) ?? []);
}

function dmLabel(room: Room): string {
  const names = dmPeople(room).map((user) => user.display_name);
  return names.length <= 1 ? (names[0] ?? "nobody") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function edit(all: Record<string, Held>, message: Message, change: Partial<Message>): Record<string, Held> {
  const room = all[message.room_id];
  if (!room) return all;
  return { ...all, [message.room_id]: { ...room, messages: room.messages.map((one) => (one.id === message.id ? { ...one, ...change } : one)) } };
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
