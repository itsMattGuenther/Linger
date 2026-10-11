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
 *   in #listening-room. `off`: nobody is in voice anywhere. `none`: the
 *   server carries no voice at all; its host hasn't set it up (#306).
 * - `?big`: #general holds 5,000 messages, all at once. `&paged`: loaded
 *   150 at a time from the newest, as the store pages them.
 * - `?fail`: every send is refused, 120 ms after it's sent. `?fail=held`:
 *   each refusal waits until the test calls `window.chat.refuse()`, so a
 *   test decides what happens first (#341).
 * - `?file`: Sam shares a PDF in #general; `&downloadfail` has the desktop
 *   fail to open a browser for it.
 * - `?long`: Eli has a name far too long for its place.
 * - `?voicefail=<the shell's reason>`: starting voice in the tab showing
 *   failed last time (#261); `&windows` words it for Windows. It asked for
 *   the system's default devices, or `&picked` for devices picked by name (#273).
 * - `?takenout`: the host took you out of voice in the tab showing (#423).
 * - `?raid`: forty-five more people in #general's voice (#197,
 *   next/raid.ts), and `window.chat.talk(ids)` says who is talking now.
 * - `?joins`: people joining voice (#473). In #general Jules joins, says
 *   something, then Dave and Callie join together; in the DM with Jules,
 *   Jules joins. With `?raid` too, twenty-five raiders join after Dave and
 *   Callie, with nothing said between.
 * - `?polls`: polls (#474). Earlier in #general Eli asked "PvP or PvE?", which
 *   closed, and its closed line is the newest thing there; before that, you
 *   asked which faction, open, with votes. With `?raid` too, thirty raiders
 *   pick Horde. `?member`: you aren't the host, so `/poll` isn't yours.
 *   Votes, closes and new polls are written to `body[data-did]`.
 * - `?reactions`: reactions (#485). In #general, five people loved what you
 *   said and two left the server's porch light; you left a 💯 on Eli's "No
 *   plans"; "Count me in" has six different, the most a message holds; and
 *   Jules's fire on the playlist sits beside a server emoji that's since been
 *   removed, which isn't drawn. Each reaction asked for is written to
 *   `body[data-did]` as `react:<id>:<key>:on|off`, and put in place as the
 *   server would. `&reactfail`: the server refuses them.
 *
 * `window.chat` lets a test make things happen: a message arriving, someone
 * typing. What the page was asked to do is written to `body[data-did]`.
 */
import { StrictMode, useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CreatePollRequest } from "../../src/generated/CreatePollRequest";
import type { Message } from "../../src/generated/Message";
import type { MessageId } from "../../src/generated/MessageId";
import type { PresenceState } from "../../src/generated/PresenceState";
import type { Room } from "../../src/generated/Room";
import type { User } from "../../src/generated/User";
import { type ChatPane, ChatView } from "../../src/next/app/chat/ChatView";
import type { DraftFile } from "../../src/next/app/chat/Composer";
import type { Submission } from "../../src/next/core/chat/sending";
import { voiceStrip } from "../../src/next/core/chat/voice";
import { voiceStartProblem } from "../../src/lib/voice";
import { closeTab, keyOf, openTab, selectTab, type TabKey, type Tabs } from "../../src/next/core/tabs";
import { markerOf, type TabItem } from "../../src/next/kit";
import { customKey, toggled, withGroup } from "../../src/lib/reactions";
import type { ReactionKit } from "../../src/next/app/chat/Reactions";
import "../../src/next/styles/app.css";
import { customEmoji, NOW, SERVER, SERVER_NAME, dms, leftOff, messages as evening, people, previews, rooms } from "./next/evening";
import { RAIDERS } from "./next/raid";

const query = new URLSearchParams(location.search);
const BIG = query.has("big");
const PAGED = BIG && query.has("paged");
const FAIL = query.has("fail");
const HOLD_REFUSALS = query.get("fail") === "held";
/** Sends waiting for `window.chat.refuse()`, with `?fail=held`. */
const refusals: (() => void)[] = [];
const VOICE = query.get("voice") ?? "others";
const PAGE = 150;

const LONG = query.has("long");
const VOICE_FAIL = query.get("voicefail");
const ASKED = query.has("picked") ? { input: "USB Microphone", output: "Headphones" } : { input: null, output: null };
const RAID = query.has("raid");
const everyone: ReadonlyMap<string, User> = new Map(
  [...Object.values(people), ...(RAID ? RAIDERS : [])].map((user) => [
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
  if (VOICE === "off" || VOICE === "none") return [];
  const others = roomId === "r-general" ? ["u-eli", "u-jules", ...(RAID ? RAIDERS.map((user) => user.id) : [])] : [];
  const mine = (VOICE === "mine" && roomId === "r-general") || (VOICE === "elsewhere" && roomId === "r-listening");
  return mine ? ["u-matt", ...others] : others;
};
const myVoice = VOICE === "mine" ? keyOf(tabOf("r-general")) : VOICE === "elsewhere" ? keyOf(tabOf("r-listening")) : null;
const SPEAKING: ReadonlySet<string> = new Set(VOICE === "off" || VOICE === "none" ? [] : ["u-eli"]);

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

/** `?file`: Sam shares the trail map, a file that isn't a picture, in #general. */
function withFile(list: Message[]): Message[] {
  const last = list.at(-1);
  if (!last) return list;
  const map: Message = {
    ...last,
    id: "m000099",
    author_id: people.sam.id,
    body: "the map for saturday",
    reply_to: null,
    reactions: [],
    created_at: last.created_at + 60_000,
    attachments: [
      {
        id: "a-map",
        filename: "river-loop-trail-map.pdf",
        mime: "application/pdf",
        size_bytes: 2_100_000,
        url: "/media/river-loop-trail-map.pdf",
        width: null,
        height: null,
        duration_ms: null,
        blurhash: null,
        poster_url: null,
        starred_at: null,
        uploader_id: people.sam.id,
        created_at: last.created_at + 60_000,
      },
    ],
  };
  return [...list, map];
}

const ALL: Record<string, Message[]> = {
  ...evening,
  ...(BIG ? { "r-general": bigRoom() } : query.has("file") ? { "r-general": withFile(evening["r-general"] ?? []) } : {}),
};
if (query.has("polls")) ALL["r-general"] = withPolls(ALL["r-general"] ?? [], RAID);
const REACTIONS = query.has("reactions");
if (REACTIONS) ALL["r-general"] = withReactions(ALL["r-general"] ?? []);

/** `?reactions`: who reacted with what, on the evening's last few messages (#485). */
function withReactions(list: Message[]): Message[] {
  const porch = customEmoji.find((one) => one.name === "porch_light");
  const on: [string, Message["reactions"]][] = [
    [
      "This is exactly what I wanted",
      [
        { key: "❤️", count: 5, user_ids: [people.eli.id, people.jules.id, people.dave.id, people.callie.id, people.sam.id] },
        ...(porch ? [{ key: customKey(porch), count: 2, user_ids: [people.jules.id, people.dave.id] }] : []),
      ],
    ],
    ["No plans, no agenda", [{ key: "💯", count: 1, user_ids: [me.id] }]],
    ["Count me in", ["😀", "😃", "😄", "😁", "😆", "😅"].map((key) => ({ key, count: 1, user_ids: [people.eli.id] }))],
    [
      "Found the playlist",
      [
        { key: "🔥", count: 1, user_ids: [people.jules.id] },
        { key: "emoji:e-gone", count: 1, user_ids: [people.dave.id] },
      ],
    ],
  ];
  return list.map((message) => {
    const found = on.find(([words]) => message.body.startsWith(words));
    return found ? { ...message, reactions: found[1] } : message;
  });
}
if (query.has("joins")) {
  ALL["r-general"] = withJoins(ALL["r-general"] ?? [], RAID);
  ALL["d-jules"] = [...(ALL["d-jules"] ?? []), joinLine("d-jules", "m000027a", people.jules.id, NOW - 60_000)];
}

/** `?polls`: you asked which faction (open); Eli asked PvP or PvE, which closed. */
function withPolls(list: Message[], raid: boolean): Message[] {
  const last = list.at(-1);
  if (!last) return list;
  const start = last.created_at;
  const base = { reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, room_id: "r-general" };
  const faction: Message = {
    ...base,
    id: `${last.id}p1`,
    author_id: me.id,
    body: "**Poll:** Which faction are we rolling on WoW Forever?\n\n- Horde\n- Alliance\n- Don't care",
    created_at: start + 30_000,
    poll: {
      question: "Which faction are we rolling on WoW Forever?",
      choices: [
        { text: "Horde", voter_ids: ["u-eli", "u-dave", "u-callie", ...(raid ? RAIDERS.slice(0, 30).map((user) => user.id) : [])] },
        { text: "Alliance", voter_ids: ["u-jules"] },
        { text: "Don't care", voter_ids: ["u-sam"] },
      ],
      multi: false,
      closes_at: NOW + 6 * 86_400_000,
      closed_at: null,
      closed_by: null,
    },
  };
  const server: Message = {
    ...base,
    id: `${last.id}p2`,
    author_id: people.eli.id,
    body: "**Poll:** PvP or PvE server?\n\n- PvP\n- PvE",
    created_at: start + 60_000,
    poll: {
      question: "PvP or PvE server?",
      choices: [
        { text: "PvP", voter_ids: ["u-eli", "u-dave"] },
        { text: "PvE", voter_ids: ["u-jules", "u-callie", "u-matt"] },
      ],
      multi: false,
      closes_at: NOW + 86_400_000,
      closed_at: start + 120_000,
      closed_by: people.eli.id,
    },
  };
  const said: Message = { ...base, id: `${last.id}p3`, author_id: people.dave.id, body: "pvp would have been more fun", created_at: start + 90_000 };
  const closed: Message = {
    ...base,
    id: `${last.id}p4`,
    author_id: people.eli.id,
    body: "Poll closed: “PvP or PvE server?” PvE won.",
    created_at: start + 120_000,
    poll_closed: { poll_id: server.id, question: "PvP or PvE server?", winners: ["PvE"] },
  };
  return [...list, faction, server, said, closed];
}

/** A line saying somebody joined voice (#473), as the server writes one. */
function joinLine(roomId: string, id: string, authorId: string, at: number): Message {
  return { id, room_id: roomId, author_id: authorId, body: "joined voice", reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: at, voice_join: true };
}

/** `?joins`: #general after Eli opens the door to voice. Ids sort after the evening's last. */
function withJoins(list: Message[], raid: boolean): Message[] {
  const last = list.at(-1);
  if (!last) return list;
  const start = last.created_at;
  const here: Message = { ...last, id: `${last.id}b`, author_id: people.jules.id, body: "here! these speakers were worth every penny", reply_to: null, reactions: [], attachments: [], created_at: start + 120_000 };
  return [
    ...list,
    joinLine("r-general", `${last.id}a`, people.jules.id, start + 60_000),
    here,
    joinLine("r-general", `${last.id}c`, people.dave.id, start + 150_000),
    joinLine("r-general", `${last.id}d`, people.callie.id, start + 165_000),
    ...(raid ? RAIDERS.slice(0, 25).map((user, n) => joinLine("r-general", `${last.id}r${String(n).padStart(2, "0")}`, user.id, start + 166_000 + n * 500)) : []),
  ];
}

declare global {
  interface Window {
    chat?: {
      /** A message arrives in a room, as if someone just said it. */
      arrive: (roomId: string, authorId: string, body: string) => void;
      /** Who is typing in a room. */
      typing: (roomId: string, userIds: string[]) => void;
      /** With `?fail=held`, refuse every send still waiting. */
      refuse: () => void;
      /** Who is talking now, by user id. */
      talk: (userIds: string[]) => void;
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
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(SPEAKING);

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
    refuse: () => refusals.splice(0).forEach((refuse) => refuse()),
    talk: (userIds) => setSpeaking(new Set(userIds)),
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
      // A DM with something new is lit as well, as tabModel draws it (#291).
      lit: room?.kind === "dm" && fresh.has(tab.roomId),
      voice: mine ? "mine" : voice.length > 0 ? "others" : undefined,
      speaking: voice.some((id) => speaking.has(id)),
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
  // A poll's vote and close (#474): written down, and put in place as the server would.
  const vote = useCallback(async (message: Message, choices: number[]) => {
    note(`vote:${message.id}:${choices.join(",")}`);
    const poll = message.poll;
    if (!poll) return;
    const choicesNow = poll.choices.map((choice, at) => ({
      ...choice,
      voter_ids: [...choice.voter_ids.filter((id) => id !== me.id), ...(choices.includes(at) ? [me.id] : [])],
    }));
    setHeld((all) => edit(all, message, { poll: { ...poll, choices: choicesNow } }));
  }, []);
  const closePoll = useCallback(async (message: Message) => {
    note(`close:${message.id}`);
    const poll = message.poll;
    if (!poll) return;
    setHeld((all) => edit(all, message, { poll: { ...poll, closed_at: NOW, closed_by: me.id } }));
  }, []);
  // `?downloadfail`: the desktop couldn't open a browser.
  const download = useCallback(async (file: { filename: string }) => {
    note(`download:${file.filename}`);
    if (query.has("downloadfail")) throw new Error("no browser to hand it to");
  }, []);
  // Reactions (#485): written down, and put in place as the server would.
  const react = useMemo<ReactionKit | undefined>(() => {
    if (!REACTIONS) return undefined;
    const custom = query.has("noemoji") ? [] : customEmoji;
    return {
      toggle: async (message: Message, key: string, on: boolean) => {
        note(`react:${message.id}:${key}:${on ? "on" : "off"}`);
        if (query.has("reactfail")) throw new Error("Couldn't add your reaction. Try again.");
        setHeld((all) => edit(all, message, { reactions: withGroup(message.reactions, toggled(message.reactions, key, me.id, on)) }));
      },
      custom,
      byId: new Map(custom.map((one) => [one.id, one])),
      serverName: SERVER_NAME,
    };
  }, []);
  const actions = useMemo(() => ({ save, remove, openLink, download, vote, closePoll, react }), [save, remove, openLink, download, vote, closePoll, react]);

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
    if (HOLD_REFUSALS) await new Promise<void>((refuse) => refusals.push(refuse));
    else await new Promise((settle) => window.setTimeout(settle, FAIL ? 120 : 40));
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
        ...chosen.map((file, index) => ({ key: `f${Date.now()}-${index}`, name: file.name, progress: 1, ready: true, problem: null, preview: null })),
      ],
    }));
  }, []);
  const onRemoveFile = useCallback((key: string) => {
    const roomId = activeRef.current;
    if (roomId !== null) setFiles((all) => ({ ...all, [roomId]: (all[roomId] ?? []).filter((file) => file.key !== key) }));
  }, []);
  const onRestoreFiles = useCallback(() => undefined, []);
  const onTyping = useCallback(() => undefined, []);
  const startPoll = useCallback(async (request: CreatePollRequest) => {
    note(`poll:${JSON.stringify(request)}`);
  }, []);
  const onJoin = useCallback(() => note("join"), []);
  const onPickDevice = useCallback(() => note("settings:sound"), []);
  // Your controls in the room you're in voice in (#216), as the chat window passes them.
  const controls = useMemo(
    () => ({ muted: false, deafened: false, onMute: () => note("mute"), onDeafen: () => note("deafen"), onLeave: () => note("leave") }),
    [],
  );

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
              knock: dmPeople(room).length === 1 ? { onKnock: () => note("knock"), phase: "idle" } : undefined,
            }
          : { kind: "room", name: room.name, topic: room.topic, people: (IN_ROOM[room.id] ?? []).flatMap((one) => everyone.get(one) ?? []) },
      voice:
        room.kind === "dm"
          ? null
          : {
              strip: voiceStrip(id, voice, me.id, myVoice, VOICE !== "none"),
              onJoin,
              onPickDevice,
              controls: myVoice === id ? controls : undefined,
              failed: VOICE_FAIL === null ? undefined : { ...voiceStartProblem(VOICE_FAIL, query.has("windows"), ASKED), detail: VOICE_FAIL },
              takenOut: query.has("takenout") && myVoice !== id,
            },
      people: everyone,
      // The server's own emoji (#359); `?noemoji` has none.
      customEmoji: query.has("noemoji") ? [] : customEmoji,
      serverName: SERVER_NAME,
      me,
      speaking,
      typing: (typing[activeRoom] ?? []).flatMap((one) => everyone.get(one) ?? []),
      // As the window lists them (core/chat/mentions.ts): a DM's people, or the room's first.
      mentionable: (room.kind === "dm"
        ? dmPeople(room)
        : [...everyone.values()].sort((a, b) => Number(!(IN_ROOM[room.id] ?? []).includes(a.id)) - Number(!(IN_ROOM[room.id] ?? []).includes(b.id)))
      )
        .filter((user) => user.id !== me.id)
        .map((user) => ({ user, state: stateOf(user) })),
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
      composer: {
        files: files[activeRoom] ?? NO_FILES,
        onAttach,
        onRemoveFile,
        onRestoreFiles,
        onSend,
        onTyping,
        // `/poll` (#474): yours as the host, unless `?member`; a DM has none.
        poll: room.kind === "dm" ? undefined : { allowed: !query.has("member"), start: startPoll },
      },
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
