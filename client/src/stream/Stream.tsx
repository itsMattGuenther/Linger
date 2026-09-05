/**
 * The message stream: the room you are looking at.
 *
 * Four things here are load-bearing.
 *
 * **It is virtualized from day one** (AGENTS). Ten thousand messages is one
 * evening in a room that gets used, and a list that renders all of them is a
 * list that has to be rewritten later. Only the rows on screen exist in the
 * DOM; every row has a stable key, so a row that was already measured stays
 * measured when older history is prepended above it.
 *
 * **The stream hangs from the bottom.** New messages push the view along when
 * you are already at the end, and history loading in above you must not move
 * what you are reading. Both are the virtualizer's `anchorTo: "end"`.
 *
 * **Nothing renders as HTML.** Message bodies are parsed into a tree of known
 * node kinds and drawn as React elements (`markdown.ts`, `MarkdownBody.tsx`), so a
 * body that looks like markup is text that looks like markup.
 *
 * **Reactions are weight, never numbers** (SPEC §4.8). The count comes down the
 * wire and goes into the hover text and the accessible label; it is never drawn
 * as a numeral.
 *
 * **Nothing here counts anything** (SPEC §4.2). Where you left off is a line in
 * the stream, not a number beside a room name, and "since you were gone" is
 * something you pull from the header rather than something that arrives.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Attachment } from "../generated/Attachment";
import type { Message } from "../generated/Message";
import type { MessageId } from "../generated/MessageId";
import type { PresenceState } from "../generated/PresenceState";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "../lib/api";
import { useNow } from "../lib/clock";
import { dmLabel } from "../dm/dm";
import { type Density } from "../lib/density";
import { emptyRoom } from "../settings/copy";
import {
  deleteMessage,
  editMessage,
  enterRoom,
  leaveWindow,
  loadNewer,
  loadOlder,
  loadUntil,
  markRead,
  openAround,
  openRoom,
  sendMessage,
  startedTyping,
  toggleReaction,
  typistsIn,
  useGateway,
} from "../lib/gateway";
import { isLooking } from "../lib/looking";
import Attachments from "../media/Attachments";
import LinkCards from "../media/LinkCards";
import { personStyle } from "../lib/names";
import { occupancyLine, occupantsOf } from "../lib/occupancy";
import { peopleList } from "../notify/rules";
import PersonName from "../status/PersonName";
import VoiceBar from "../voice/VoiceBar";
import MarkdownBody, { type MentionLookup } from "./MarkdownBody";
import { uploadFile } from "../lib/upload";
import { linkTargets, mentionHandles, plainText } from "./markdown";
import { REACTIONS, reactionOf, reactionTitle, reactionWeight } from "./reactions";
import { buildRows, type StreamRow } from "./rows";
import { ageOpacity, clockTime, fullTime, sessionLabel } from "./time";
import "./stream.css";

/**
 * Start fetching older history once the top of the loaded range comes this
 * close. Roughly two screens: far enough ahead that the page has landed before
 * anyone reaches the end of what is there.
 */
const BACKFILL_MARGIN_PX = 1200;

/**
 * `linger-core::limits::MAX_MESSAGE_CHARS`. The server is the authority and
 * refuses anything longer; this copy exists so the composer can say so before
 * the round trip rather than after it.
 */
const MAX_MESSAGE_CHARS = 8000;

/** How much of a quoted message the reply line shows before it trails off. */
const REPLY_EXCERPT_CHARS = 140;

/** `linger-core::limits::MAX_ATTACHMENTS_PER_MESSAGE`, mirrored like the char
 *  cap above so the composer can refuse the eleventh file without a round
 *  trip. */
const MAX_ATTACHMENTS = 10;

/**
 * How close to the bottom counts as having seen the newest message. A couple of
 * lines of slack, because a scroll that lands a pixel short is still a person
 * looking at the end of the room.
 */
const BOTTOM_MARGIN_PX = 48;

/** How many people "since you were gone" names before it trails off. */
const SINCE_NAMES = 5;

/**
 * How a jump to a message knows it has arrived.
 *
 * A virtualized row is an estimated height until it has been drawn, so a jump
 * re-aims every frame. Knowing when to stop is the whole difficulty, and there
 * are three parts to it because two of them are individually wrong.
 *
 * `STILL` frames of an unchanged aim is not enough on its own: at the moment a
 * jump starts, *every* row is the same estimate, so the aim is perfectly stable
 * and perfectly wrong, and it stays that way until the first measurements land.
 * That is the bug this replaced — it settled in five frames on a list of
 * guesses, and the real heights then pushed the message off the top.
 *
 * So the total measured height has to hold still as well, and `MIN` frames have
 * to have passed. The floor is what covers the gap before measurements start
 * arriving: they come from a ResizeObserver, which reports after a paint rather
 * than on the frame clock, so the first few frames of any jump are a list that
 * has not been measured at all.
 *
 * `MAX` is the seatbelt: about a second and a half, then the scrollbar goes
 * back to whoever wants it.
 */
const JUMP_STILL_FRAMES = 5;
const JUMP_MIN_FRAMES = 20;
const JUMP_MAX_FRAMES = 90;

/**
 * What a message row can ask the stream to do. The two that talk to the server
 * hand back the promise rather than swallowing it, because the row is where a
 * refusal has to be shown — it is the thing the person was pointing at.
 */
interface Actions {
  reply: (message: Message) => void;
  edit: (message: Message) => void;
  react: (message: Message, key: string) => Promise<void>;
  remove: (message: Message) => Promise<void>;
  jumpTo: (id: MessageId) => void;
}

interface StreamProps {
  api: AuthedApi;
  room: Room;
  /** Everyone the server has told us about, for author names and colors. */
  users: User[];
  /**
   * How the stream is laid out. Read here, never changed here: the control
   * lives in settings, because it is a preference somebody sets once (T-904).
   */
  density: Density;
  /**
   * A message to go and find, from the media collection (SPEC §4.4: "each item
   * links back to the message and moment it was posted in"). It may be well
   * outside the loaded history, so finding it means loading backwards until it
   * is in range.
   */
  focus?: MessageId | null;
  /** Called once the hunt is over, found or not, so the frame can let go. */
  onFocused?: () => void;
  /**
   * The roster, on a window too narrow to give it a column of its own. It
   * belongs here rather than in the frame because SPEC §3 puts the strip
   * *above the composer*, and the composer is in this file.
   */
  roster?: ReactNode;
}

export default function Stream({
  api,
  room,
  users,
  density,
  focus,
  onFocused,
  roster,
}: StreamProps) {
  const gateway = useGateway(api.baseUrl);
  const stream = gateway.streams[room.id];
  const me = gateway.me;
  const loaded = stream !== undefined;
  const now = useNow();
  const scroller = useRef<HTMLDivElement | null>(null);

  // A room re-opens itself if the store drops it, which happens when a
  // re-identify throws loaded history away.
  useEffect(() => {
    if (!loaded) void openRoom(api, room.id);
  }, [api, room.id, loaded]);

  // Walking in is what pins the "you left off here" line. Keyed on the room
  // alone so it happens once per visit rather than once per message that
  // arrives while you are standing there.
  useEffect(() => {
    enterRoom(api.baseUrl, room.id);
  }, [api.baseUrl, room.id]);

  const people = useMemo(() => new Map(users.map((person) => [person.id, person])), [users]);
  // Presence per author, for the card a name opens. Built once here rather
  // than read by each name: every row in a virtualized list subscribing to the
  // store on its own would re-render the whole stream on every presence frame.
  const states = useMemo(
    () => new Map(gateway.presence.map((entry) => [entry.user_id, entry.state])),
    [gateway.presence],
  );

  // A mention names a username, because that is the thing that is unique on a
  // server and the thing somebody actually typed.
  const byHandle = useMemo(
    () => new Map(users.map((person) => [person.username, person])),
    [users],
  );
  const mentions = useCallback<MentionLookup>(
    (handle) => {
      const person = byHandle.get(handle);
      if (person === undefined) return null;
      return { name: person.display_name, me: person.id === me?.id };
    },
    [byHandle, me?.id],
  );

  // What this conversation is called, in one place. A room is its slug with a
  // `#`; a DM has no name of its own and is drawn by who is in it (SPEC §4.13)
  // — its `slug` and `name` are generated and mean nothing.
  const isDm = room.kind === "dm";
  const title = isDm ? dmLabel(room, users, me?.id ?? null) : `#${room.slug}`;

  const messages = stream?.messages;
  const atStart = stream?.atStart ?? false;
  // False only while the room is showing a historical window — a search hit
  // landed on with `openAround`. Everything that assumes "the bottom of this
  // list is the newest thing said here" has to check it (SPEC §4.12).
  const atEnd = stream?.atEnd ?? true;
  // Pinned when the room was opened and never moved after that, so the line
  // stays somewhere you can find your way back to (SPEC §4.2).
  const leftOff = gateway.leftOff[room.id] ?? null;
  const rows = useMemo(
    // IRC mode is one self-contained line per message, so it does not group.
    () => buildRows(messages ?? [], { group: density !== "irc", atStart, leftOff }),
    [messages, atStart, density, leftOff],
  );

  // Replies point at a message by id, and a reply line has to show what it is
  // answering, so the loaded history needs to be addressable both ways.
  const byId = useMemo(() => new Map((messages ?? []).map((held) => [held.id, held])), [messages]);
  const rowOf = useMemo(() => {
    const index = new Map<MessageId, number>();
    rows.forEach((row, at) => {
      if (row.kind === "message") index.set(row.message.id, at);
    });
    return index;
  }, [rows]);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<MessageId | null>(null);
  const [flash, setFlash] = useState<MessageId | null>(null);
  const [since, setSince] = useState(false);

  // A half-written reply belongs to the room it was written in.
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setFlash(null);
    setSince(false);
  }, [room.id]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    // A one-line message in Comfortable. Wrong for most rows, which is fine —
    // it is a starting guess and every row is measured for real once drawn.
    estimateSize: () => 26,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    anchorTo: "end",
    followOnAppend: true,
  });

  // Walking into a room puts you at the newest message, not where you last
  // were.
  //
  // Getting there takes several goes, and this is the part that is easy to get
  // wrong. Every row starts life as an estimated height and only gets its real
  // one once it has been drawn, so the first jump aims at the bottom of a list
  // of guesses and lands somewhere in the middle of the real one. Drawing the
  // rows it lands on corrects their heights, which moves the bottom again.
  //
  // So jump once per frame until the last row is genuinely on screen. A frame
  // is the right beat because the browser reports a scroll asynchronously: jump
  // twice inside one frame and the second jump is aiming with the first one's
  // stale numbers. And the test is "the last row is drawn", not "the total
  // stopped growing" — the total holds still for a frame all the time while
  // measurements are still arriving.
  const landing = useRef({ room: "", done: false });
  useEffect(() => {
    if (rows.length === 0) return;
    if (landing.current.room !== room.id) landing.current = { room: room.id, done: false };
    if (landing.current.done) return;
    // A room opened *at* a message is already where it was asked to be; the
    // bottom of its window is six months ago and nobody asked to go there.
    if (!atEnd) return;

    let frames = 0;
    let pending = 0;
    const step = (): void => {
      // A jump marks the landing done the moment it starts (`jumpTo`). Two
      // loops aiming at two different rows fight, and the one aiming at an
      // eight-month-old message is the one the person asked for.
      if (landing.current.done) return;
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      const drawn = virtualizer.getVirtualItems();
      frames += 1;
      // The frame cap is a seatbelt, not a mechanism: a room that never settles
      // has to give the scrollbar back rather than fight for it forever.
      if (drawn[drawn.length - 1]?.index === rows.length - 1 || frames >= 60) {
        landing.current.done = true;
        return;
      }
      pending = requestAnimationFrame(step);
    };
    pending = requestAnimationFrame(step);
    return () => cancelAnimationFrame(pending);
  }, [room.id, rows.length, atEnd, virtualizer]);

  // Following a new message down is not one scroll, for the same reason
  // walking into a room is not: a row is an estimated height until it has been
  // drawn once, so the virtualizer's own `followOnAppend` aims at a bottom
  // computed from a guess and lands short by however much the guess was wrong.
  // Before markdown every message was a line or two and the error was a few
  // pixels. A message with a code block in it is off by a screenful.
  //
  // So re-aim per frame until the last row is really drawn — and only when the
  // bottom is what you were looking at. Keying this on the *last* row means a
  // page of older history loading in above never triggers it: that changes how
  // many rows there are without changing which one is last.
  const lastKey = rows[rows.length - 1]?.key;
  useEffect(() => {
    const element = scroller.current;
    if (!element || rows.length === 0 || !landing.current.done || !atEnd) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > element.clientHeight) {
      return;
    }
    let frames = 0;
    let pending = 0;
    const step = (): void => {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      const drawn = virtualizer.getVirtualItems();
      frames += 1;
      if (drawn[drawn.length - 1]?.index === rows.length - 1 || frames >= 30) return;
      pending = requestAnimationFrame(step);
    };
    pending = requestAnimationFrame(step);
    return () => cancelAnimationFrame(pending);
  }, [lastKey, rows.length, atEnd, virtualizer]);

  // The row index of every message, as of the last render. A jump re-aims over
  // many frames while pages may still be arriving above it, so it has to look
  // the row up *each frame* rather than hold the number it started with —
  // one page loading in above the target moves every index below it.
  const rowOfNow = useRef(rowOf);
  rowOfNow.current = rowOf;

  // Set while a jump is re-aiming. Backfill has to keep out of the way: a jump
  // passes through the top of the list on its way, and a `loadOlder` fired from
  // there prepends a page, moves the target, and starts the whole thing again —
  // which walks a room all the way back to its first message.
  const jumping = useRef(false);

  /**
   * You have read what you can see.
   *
   * Two conditions, and the second one is the one people forget: the newest
   * message has to be on screen, *and* the window has to have your attention
   * (`isLooking`, the same clock occupancy uses). A room sitting open on a
   * second monitor while you type somewhere else has not been read, and
   * marking it read would quietly eat the line that tells you where you
   * stopped.
   */
  const noteRead = useCallback(() => {
    const element = scroller.current;
    const newest = messages?.[messages.length - 1];
    // The bottom of a historical window is not the bottom of the room, and
    // marking it read would eat the line that says where you actually stopped.
    if (!atEnd) return;
    if (!element || newest === undefined || !isLooking()) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > BOTTOM_MARGIN_PX) return;
    markRead(api, room.id, newest.id);
  }, [api, room.id, messages, atEnd]);

  useEffect(() => {
    noteRead();
    window.addEventListener("focus", noteRead);
    return () => window.removeEventListener("focus", noteRead);
  }, [noteRead]);

  const backfill = useCallback(() => {
    noteRead();
    const element = scroller.current;
    if (!element || jumping.current) return;
    if (element.scrollTop <= BACKFILL_MARGIN_PX) void loadOlder(api, room.id);
    // The other edge only exists inside a historical window, and reading to the
    // bottom of one is how the room becomes whole again.
    const below = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (below <= BACKFILL_MARGIN_PX) void loadNewer(api, room.id);
  }, [api, room.id, noteRead]);

  // Where "go to where you left off" goes.
  const leftOffRow = useMemo(() => rows.findIndex((row) => row.kind === "left-off"), [rows]);
  const goToLeftOff = useCallback(() => {
    if (leftOffRow < 0) return;
    // The same re-aim the rest of this file does, and for the same reason: a
    // row is an estimated height until it has been drawn, so one jump lands
    // near the target rather than on it.
    let frames = 0;
    const step = (): void => {
      virtualizer.scrollToIndex(leftOffRow, { align: "start" });
      frames += 1;
      if (frames < 6) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [leftOffRow, virtualizer]);

  // A room whose first page doesn't fill the window needs the next one before
  // anybody scrolls, or there is nothing to scroll.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !stream || stream.loading || jumping.current) return;
    if (element.scrollHeight - element.clientHeight > BACKFILL_MARGIN_PX) return;
    if (!stream.atStart) void loadOlder(api, room.id);
    else if (!stream.atEnd) void loadNewer(api, room.id);
  }, [api, room.id, stream]);

  const actions: Actions = useMemo(
    () => ({
      reply: (message) => {
        setEditing(null);
        setReplyTo(message);
      },
      edit: (message) => {
        setReplyTo(null);
        setEditing(message.id);
      },
      react: (message, key) => toggleReaction(api, message, key),
      remove: (message) => deleteMessage(api, message),
      jumpTo: (id) => {
        if (rowOfNow.current.get(id) === undefined) return;
        // The same re-aim walking into a room does, and for the same reason:
        // every row above the target is an estimated height until it has been
        // drawn, so one jump aims with guesses and lands near the message
        // rather than on it. Each go corrects the rows it lands on, which moves
        // the target, so keep jumping — once per frame, because the browser
        // reports a scroll asynchronously and two jumps in one frame means the
        // second one aims with the first one's stale numbers.
        //
        // Done is: the row is drawn, it is actually inside the viewport, and
        // both the aim and the measured height of the list have held still for
        // a run of frames — after a floor of frames that gives the first
        // measurements time to arrive. See `JUMP_STILL_FRAMES` above for why
        // each of those is there.
        landing.current = { room: room.id, done: true };
        jumping.current = true;
        let frames = 0;
        let still = 0;
        let aim = -1;
        let height = -1;
        const step = (): void => {
          const index = rowOfNow.current.get(id);
          if (index === undefined) {
            jumping.current = false;
            return;
          }
          virtualizer.scrollToIndex(index, { align: "center" });
          frames += 1;
          const offset = virtualizer.scrollOffset ?? 0;
          const total = virtualizer.getTotalSize();
          still = offset === aim && total === height ? still + 1 : 0;
          aim = offset;
          height = total;

          // On screen, not merely drawn: the virtualizer keeps a margin of
          // rows either side of the viewport, so "drawn" includes rows nobody
          // can see.
          const row = virtualizer.getVirtualItems().find((one) => one.index === index);
          const view = scroller.current;
          const onScreen =
            row !== undefined &&
            view !== null &&
            row.end - offset > 0 &&
            row.start - offset < view.clientHeight;

          const settled = onScreen && still >= JUMP_STILL_FRAMES && frames >= JUMP_MIN_FRAMES;
          // The frame cap is a seatbelt, not a mechanism: a list that never
          // settles has to give the scrollbar back rather than hold it forever.
          if (settled || frames >= JUMP_MAX_FRAMES) {
            jumping.current = false;
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        // The message you jumped to is somewhere in the middle of a screen of
        // other messages, so say which one it was. It fades on its own; there
        // is nothing to dismiss.
        setFlash(id);
        window.setTimeout(() => setFlash((current) => (current === id ? null : current)), 1600);
      },
    }),
    [api, room.id, virtualizer],
  );

  /**
   * Going to a message the media grid or a search hit pointed at.
   *
   * Two ways to get there, and which one is right depends on how far away it
   * is. If the message is already loaded, or within a page or two of the
   * newest, walking backwards is cheap and keeps the scrollback that is
   * already on screen — that is `loadUntil`, the same reach "since you were
   * gone" uses, and it stops at a thousand messages.
   *
   * Past that, walking is the wrong tool: a search hit six months back in a
   * busy room is thousands of messages behind the newest, which is dozens of
   * round trips for history nobody asked to read. So the room is re-opened
   * *at* the message instead (`openAround`, PROTOCOL §4). That throws the
   * loaded history away and leaves the room detached from the newest message
   * until somebody reads forwards out of it, which is why it is the second
   * choice rather than the first.
   *
   * `done` is how the hunt ends when it fails: without it, a message that no
   * longer exists would leave the frame waiting forever.
   */
  const [hunting, setHunting] = useState<{ id: MessageId; done: boolean } | null>(null);
  useEffect(() => {
    if (focus === null || focus === undefined) return undefined;
    let alive = true;
    setHunting({ id: focus, done: false });
    void (async () => {
      await openRoom(api, room.id);
      const reached = await loadUntil(api, room.id, focus);
      if (!reached) await openAround(api, room.id, focus);
      if (alive) {
        setHunting((current) => (current?.id === focus ? { id: focus, done: true } : current));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, room.id, focus]);

  useEffect(() => {
    if (hunting === null) return;
    if (rowOf.has(hunting.id)) {
      actions.jumpTo(hunting.id);
      setHunting(null);
      onFocused?.();
    } else if (hunting.done) {
      // Further back than the client will reach. The room is open at the
      // newest message, which is where somebody who cannot get there is best
      // left — and better than a spinner that never stops.
      setHunting(null);
      onFocused?.();
    }
  }, [hunting, rowOf, actions, onFocused]);

  // The composer's Up-arrow shortcut, and the keyboard's only route to editing.
  const lastMine = useMemo(() => {
    const held = messages ?? [];
    for (let at = held.length - 1; at >= 0; at -= 1) {
      const message = held[at];
      if (message && message.author_id === me?.id && message.deleted_at === null) return message;
    }
    return null;
  }, [messages, me?.id]);

  const items = virtualizer.getVirtualItems();
  const newest = gateway.newest[room.id];
  // Something happened here after you stopped reading. The header offers to
  // tell you about it; nothing pushes it at you (SPEC §4.2).
  const strayed = leftOff !== null && newest !== undefined && newest > leftOff;
  const who = occupancyLine(
    occupantsOf(room.id, gateway.occupancy, gateway.presence, users),
  );

  return (
    <main className="stream">
      <header className="stream-header">
        <span className="room-title">
          <span className="room-name">{title}</span>
          {who !== "" ? <span className="room-occupancy meta">· {who}</span> : null}
        </span>
        {room.topic ? <span className="room-topic meta">{room.topic}</span> : null}
        {/* The way out of a historical window (SPEC §4.12). A room opened on a
            search hit is showing February, and without this the only route back
            to today is scrolling through everything in between. Reading
            forwards to the bottom gets there too — this is the shortcut. */}
        {atEnd ? null : (
          <button
            type="button"
            className="since-pull meta"
            onClick={() => void leaveWindow(api, room.id)}
          >
            back to the newest
          </button>
        )}
        {strayed && atEnd ? (
          <button
            type="button"
            className="since-pull meta"
            aria-expanded={since}
            onClick={() => setSince((open) => !open)}
          >
            since you were gone
          </button>
        ) : null}
      </header>

      {/* Voice happens in the room (SPEC §4.14), so its one line sits under
          the room's header and nowhere else. */}
      <VoiceBar api={api} room={room} users={users} />

      {strayed && since && leftOff !== null ? (
        <SinceYouWereGone
          api={api}
          roomId={room.id}
          leftOff={leftOff}
          messages={messages ?? []}
          atStart={atStart}
          people={people}
          now={now}
          onGo={() => {
            setSince(false);
            goToLeftOff();
          }}
        />
      ) : null}

      {/* `tabIndex` is not decoration: scrollback has to be reachable without a
          mouse, and focused, this takes arrow keys and Page Up like any other
          scrolling region. */}
      <div
        className="stream-body"
        ref={scroller}
        onScroll={backfill}
        role="log"
        aria-label={isDm ? `messages with ${title}` : `messages in ${title}`}
        tabIndex={0}
      >
        {rows.length === 0 ? (
          <p className="placeholder">
            {loaded && atStart ? emptyRoom() : "…"}
          </p>
        ) : (
          <div className="stream-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const author =
                row.kind === "message" ? people.get(row.message.author_id) : undefined;
              return (
                <div
                  key={item.key}
                  className="stream-row"
                  data-index={item.index}
                  data-head={row.kind === "message" && row.head}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)`, ...personStyle(author) }}
                >
                  {row.kind === "divider" ? (
                    <p className="stream-divider">
                      <span className="divider-label">{sessionLabel(row.at, now)}</span>
                    </p>
                  ) : row.kind === "left-off" ? (
                    // The whole of what replaces the badge. One line, in accent,
                    // which SPEC §5.3 spends on exactly four things and this is
                    // the first of them.
                    <p className="left-off">
                      <span className="left-off-label">you left off here</span>
                    </p>
                  ) : (
                    <MessageRow
                      api={api}
                      row={row}
                      author={author}
                      authorState={states.get(row.message.author_id) ?? "offline"}
                      me={me}
                      people={people}
                      mentions={mentions}
                      repliedTo={
                        row.message.reply_to === null ? undefined : byId.get(row.message.reply_to)
                      }
                      now={now}
                      irc={density === "irc"}
                      editing={editing === row.message.id}
                      flashing={flash === row.message.id}
                      onEditDone={() => setEditing(null)}
                      actions={actions}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {roster}

      <Typing api={api} roomId={room.id} people={people} />

      <Composer
        api={api}
        room={room}
        title={title}
        isDm={isDm}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onEditLast={() => {
          if (lastMine) actions.edit(lastMine);
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

function MessageRow({
  api,
  row,
  author,
  authorState,
  me,
  people,
  mentions,
  repliedTo,
  now,
  irc,
  editing,
  flashing,
  onEditDone,
  actions,
}: {
  api: AuthedApi;
  row: Extract<StreamRow, { kind: "message" }>;
  author: User | undefined;
  me: User | null;
  authorState: PresenceState;
  people: Map<string, User>;
  mentions: MentionLookup;
  repliedTo: Message | undefined;
  now: number;
  irc: boolean;
  editing: boolean;
  flashing: boolean;
  onEditDone: () => void;
  actions: Actions;
}) {
  const { message, head } = row;
  const name = author?.display_name ?? "someone";
  const deleted = message.deleted_at !== null;
  // The marker half of SPEC §4.2's one exception: a message that names you is
  // findable by eye when you scroll back through a room, not just by the
  // notification you may have missed.
  const namesMe = useMemo(
    () => me !== null && !deleted && mentionHandles(message.body).includes(me.username),
    [message.body, me, deleted],
  );
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A delete the server refuses, or a reaction that didn't land, has to say so
  // next to the message it was aimed at. Anywhere else and it reads as being
  // about something you are not looking at.
  const run = (work: Promise<void>): void => {
    setProblem(null);
    void work.catch((error: unknown) => {
      setProblem(error instanceof ApiError ? error.message : "Couldn't reach the server.");
    });
  };

  const time = (
    <time
      className="msg-time meta"
      dateTime={new Date(message.created_at).toISOString()}
      title={fullTime(message.created_at)}
    >
      {clockTime(message.created_at, irc)}
    </time>
  );

  const body = deleted ? (
    <span className="msg-gone">deleted</span>
  ) : editing ? (
    <EditBox api={api} message={message} onDone={onEditDone} />
  ) : (
    <MarkdownBody
      source={message.body}
      mentions={mentions}
      trailing={
        message.edited_at === null ? undefined : <span className="msg-edited meta">edited</span>
      }
    />
  );

  const mine = me !== null && message.author_id === me.id;
  const bodyStyle: CSSProperties = { "--age": ageOpacity(message.created_at, now) };

  // What the message links to, taken from the parsed tree rather than a scan of
  // the text, so a card is drawn for exactly what draws as a link.
  const links = useMemo(
    () => (deleted || editing ? [] : linkTargets(message.body)),
    [message.body, deleted, editing],
  );
  const extras =
    deleted || editing ? null : (
      <>
        <Attachments files={message.attachments} />
        <LinkCards api={api} urls={links} />
      </>
    );

  return (
    <div
      className="msg"
      data-flash={flashing ? "true" : undefined}
      data-names-me={namesMe ? "true" : undefined}
      onMouseLeave={() => {
        setPicking(false);
        setConfirming(false);
      }}
    >
      {repliedTo === undefined && message.reply_to === null ? null : (
        <ReplyLine target={repliedTo} people={people} onJump={actions.jumpTo} />
      )}

      {/* One line per message, timestamps in a fixed-width gutter, the aligned
          nick column mIRC had (SPEC §5, §5.6). No group header, because there
          is no group. */}
      {irc ? (
        <div className="msg-body">
          {time}
          <PersonName user={author} name={name} state={authorState} className="irc-name" />
          <span className="irc-text">{body}</span>
        </div>
      ) : (
        <>
          {head ? (
            <p className="msg-head">
              <PersonName user={author} name={name} state={authorState} className="msg-author" />
              {time}
            </p>
          ) : null}
          {/* Aging is one custom property, computed from the timestamp and
              applied to the body only — never the name, never the time
              (SPEC §5.6). */}
          <div className="msg-body" style={bodyStyle}>
            {body}
          </div>
        </>
      )}

      {extras}

      {problem ? <p className="msg-problem meta">{problem}</p> : null}

      {message.reactions.length === 0 ? null : (
        <Reactions
          message={message}
          me={me}
          people={people}
          onReact={(target, key) => run(actions.react(target, key))}
        />
      )}

      {deleted || editing ? null : (
        <div className="msg-actions">
          {picking ? (
            REACTIONS.map((reaction) => (
              <button
                key={reaction.key}
                type="button"
                className="msg-action msg-action-glyph"
                title={reaction.label}
                aria-label={`react with ${reaction.label}`}
                onClick={() => {
                  run(actions.react(message, reaction.key));
                  setPicking(false);
                }}
              >
                {reaction.glyph}
              </button>
            ))
          ) : (
            <>
              {/* Twelve fixed marks, not an emoji picker (SPEC §4.8) — they
                  take over this same strip rather than opening a layer, which
                  keeps the row the height it already was. */}
              <button
                type="button"
                className="msg-action meta"
                onClick={() => setPicking(true)}
                aria-label={`react to ${name}'s message`}
              >
                react
              </button>
              <button
                type="button"
                className="msg-action meta"
                onClick={() => actions.reply(message)}
                aria-label={`reply to ${name}`}
              >
                reply
              </button>
              {mine ? (
                <button
                  type="button"
                  className="msg-action meta"
                  onClick={() => actions.edit(message)}
                >
                  edit
                </button>
              ) : null}
              {mine || me?.is_host === true ? (
                confirming ? (
                  <>
                    <button
                      type="button"
                      className="msg-action msg-action-danger meta"
                      onClick={() => run(actions.remove(message))}
                    >
                      delete for good
                    </button>
                    <button
                      type="button"
                      className="msg-action meta"
                      onClick={() => setConfirming(false)}
                    >
                      keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="msg-action meta"
                    onClick={() => setConfirming(true)}
                  >
                    delete
                  </button>
                )
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Since you were gone", pulled from the room header.
 *
 * SPEC §4.2 is specific that this is something you ask for and never something
 * that arrives, so it does not exist until you open it. What it tells you is
 * *who* has spoken and *when* it started — never how much, because how much is
 * the number this whole app exists to not show you. A count would also be the
 * one thing here that is a lie, since the client only holds the pages it has
 * fetched.
 *
 * Opening it reaches back through history until the message you stopped at is
 * loaded, which is what lets the "you left off here" line be drawn at all when
 * you have been away longer than one page.
 */
function SinceYouWereGone({
  api,
  roomId,
  leftOff,
  messages,
  atStart,
  people,
  now,
  onGo,
}: {
  api: AuthedApi;
  roomId: RoomId;
  leftOff: MessageId;
  messages: readonly Message[];
  atStart: boolean;
  people: Map<string, User>;
  now: number;
  onGo: () => void;
}) {
  useEffect(() => {
    void loadUntil(api, roomId, leftOff);
  }, [api, roomId, leftOff]);

  const found = atStart || messages.some((message) => message.id <= leftOff);
  const after = messages.filter(
    (message) => message.id > leftOff && message.deleted_at === null,
  );

  // Everyone who has spoken since, in the order they first did.
  const names: string[] = [];
  for (const message of after) {
    const who = people.get(message.author_id)?.display_name ?? "someone";
    if (!names.includes(who)) names.push(who);
  }
  const opened = after[0];

  return (
    <section className="since" aria-label="since you were gone">
      {!found ? (
        <p className="meta">looking back…</p>
      ) : opened === undefined ? (
        <p className="meta">nothing since.</p>
      ) : (
        <>
          <p className="since-who">
            {names.length > SINCE_NAMES
              ? `${peopleList(names.slice(0, SINCE_NAMES))} and others`
              : peopleList(names)}
            <span className="since-when meta">{sessionLabel(opened.created_at, now)}</span>
          </p>
          <button type="button" className="since-go meta" onClick={onGo}>
            go to where you left off
          </button>
        </>
      )}
    </section>
  );
}

/** The line above a reply saying what it is answering. */
function ReplyLine({
  target,
  people,
  onJump,
}: {
  target: Message | undefined;
  people: Map<string, User>;
  onJump: (id: MessageId) => void;
}) {
  // The message being answered may simply not be loaded — it is older than the
  // pages we hold. Saying so is better than pretending the reply is a normal
  // message, because the indent already told you it isn't.
  if (target === undefined) {
    return (
      <p className="msg-reply meta">
        <span className="reply-mark">↩</span> an earlier message
      </p>
    );
  }
  const author = people.get(target.author_id);
  const who = author?.display_name ?? "someone";
  const excerpt =
    target.deleted_at !== null ? "deleted" : shorten(plainText(target.body), REPLY_EXCERPT_CHARS);
  return (
    <button type="button" className="msg-reply meta" onClick={() => onJump(target.id)}>
      <span className="reply-mark">↩</span>
      {/* The quoted author's color, not the row's — the row belongs to whoever
          is replying. This line is mono metadata, so it takes the color and
          stops there: a shimmering name inside a one-line quote is noise. */}
      <span className="reply-author name-color" style={personStyle(author)}>
        {who}
      </span>
      <span className="reply-excerpt">{excerpt}</span>
    </button>
  );
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * The marks on a message.
 *
 * Each one's `--weight` runs 0 to 1 and CSS turns it into size and density. No
 * numeral appears: the tally lives in the hover title and the accessible label,
 * which is where SPEC §4.8 puts it.
 */
function Reactions({
  message,
  me,
  people,
  onReact,
}: {
  message: Message;
  me: User | null;
  people: Map<string, User>;
  onReact: (message: Message, key: string) => void;
}) {
  return (
    <div className="reactions">
      {message.reactions.map((group) => {
        // A key this build has never heard of is skipped rather than guessed
        // at, so a newer server adding a thirteenth mark doesn't draw a blank.
        const reaction = reactionOf(group.key);
        if (!reaction) return null;
        const names = group.user_ids.map((id) => people.get(id)?.display_name ?? "someone");
        const mine = me !== null && group.user_ids.includes(me.id);
        const counted = `${group.count} ${group.count === 1 ? "person" : "people"}`;
        return (
          <button
            key={group.key}
            type="button"
            className="reaction"
            data-mine={mine ? "true" : undefined}
            style={{ "--weight": reactionWeight(group.count) }}
            title={reactionTitle(names, reaction.label)}
            aria-pressed={mine}
            aria-label={`${reaction.label}, ${counted}`}
            onClick={() => onReact(message, group.key)}
          >
            <span aria-hidden="true">{reaction.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Editing in place. Enter saves, Escape gives up, the text survives a refusal. */
function EditBox({
  api,
  message,
  onDone,
}: {
  api: AuthedApi;
  message: Message;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(message.body);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.focus();
    // The cursor belongs at the end of what is already there, not the start:
    // most edits are a fix at the end or an afterthought.
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  useAutoGrow(box, draft);

  const save = async (): Promise<void> => {
    const body = draft.trim();
    if (saving) return;
    if (body === message.body.trim()) {
      onDone();
      return;
    }
    if (body.length === 0) {
      setProblem("An empty message is a delete, and that is a different button.");
      return;
    }
    setSaving(true);
    try {
      await editMessage(api, message, body);
      onDone();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="msg-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        ref={box}
        className="composer-input"
        rows={1}
        value={draft}
        maxLength={MAX_MESSAGE_CHARS}
        aria-label="edit this message"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {problem ? <p className="composer-problem meta">{problem}</p> : null}
      <p className="msg-edit-hint meta">enter saves · escape cancels</p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** One file on its way up, as the composer holds it. */
interface Pending {
  key: string;
  name: string;
  /** 0 to 1. */
  progress: number;
  /** Set once the server has the bytes and has looked at them. */
  attachment: Attachment | null;
  problem: string | null;
}

function Composer({
  api,
  room,
  title,
  isDm,
  replyTo,
  onClearReply,
  onEditLast,
}: {
  api: AuthedApi;
  room: Room;
  /** What this conversation is called — `#garage`, or the people in a DM. */
  title: string;
  isDm: boolean;
  replyTo: Message | null;
  onClearReply: () => void;
  onEditLast: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const [dropping, setDropping] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  // Switching rooms should not carry a half-typed line into the new one.
  useEffect(() => {
    setDraft("");
    setProblem(null);
    // Files, though, are not dropped: they are already on the server, and
    // throwing one away because somebody clicked another room would be losing
    // an upload they have been waiting for. They go with the composer.
  }, [room.id]);

  /**
   * Start uploading whatever was dropped, pasted or picked.
   *
   * Each file goes up on its own and reports its own progress, because that is
   * what the pipeline is: one dropped connection costs one part, not the
   * afternoon (PROTOCOL §6). A refusal is shown against the file it was about.
   */
  const attach = (chosen: File[]): void => {
    setProblem(null);
    setFiles((held) => {
      const room = MAX_ATTACHMENTS - held.length;
      if (chosen.length > room) {
        setProblem(`One message carries at most ${MAX_ATTACHMENTS} files.`);
      }
      const taking = chosen.slice(0, Math.max(0, room));
      for (const file of taking) {
        const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
        void uploadFile(api, file, {
          onProgress: (fraction) =>
            setFiles((current) =>
              current.map((one) => (one.key === key ? { ...one, progress: fraction } : one)),
            ),
        })
          .then((attachment) =>
            setFiles((current) =>
              current.map((one) => (one.key === key ? { ...one, attachment, progress: 1 } : one)),
            ),
          )
          .catch((error: unknown) =>
            setFiles((current) =>
              current.map((one) =>
                one.key === key
                  ? {
                      ...one,
                      problem:
                        error instanceof ApiError ? error.message : "That file didn't go up.",
                    }
                  : one,
              ),
            ),
          );
        held = [...held, { key, name: file.name, progress: 0, attachment: null, problem: null }];
      }
      return held;
    });
  };

  const drop = (key: string): void => {
    const going = files.find((one) => one.key === key);
    setFiles((held) => held.filter((one) => one.key !== key));
    // An upload that finished is a file sitting on the server with nothing
    // pointing at it. Take it back rather than leaving it against the pool.
    if (going?.attachment) void api.cancelUpload(String(going.attachment.id)).catch(() => undefined);
  };

  // Choosing to reply is choosing to type, so put the cursor where the typing
  // goes.
  useEffect(() => {
    if (replyTo) box.current?.focus();
  }, [replyTo]);

  useAutoGrow(box, draft);

  const ready = files.filter((one) => one.attachment !== null);
  const working = files.some((one) => one.attachment === null && one.problem === null);

  const submit = async (): Promise<void> => {
    const body = draft.trim();
    // A message with a file on it may say nothing at all — sharing a photo
    // without a caption is the ordinary case (PROTOCOL §4).
    if ((body.length === 0 && ready.length === 0) || sending || working) return;
    setSending(true);
    try {
      await sendMessage(
        api,
        room.id,
        body,
        replyTo?.id ?? null,
        ready.map((one) => one.attachment).flatMap((one) => (one === null ? [] : [one.id])),
      );
      setDraft("");
      setFiles([]);
      setProblem(null);
      onClearReply();
    } catch (error) {
      // The composer is the only thing holding what they typed, so it is the
      // only thing that can tell them it did not go — and it keeps the text.
      setProblem(error instanceof ApiError ? error.message : "Couldn't reach the server.");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape" && replyTo) {
      event.preventDefault();
      onClearReply();
      return;
    }
    // Up arrow in an empty box edits the last thing you said. It is the habit
    // from every other chat client, and it is the only way to reach `edit`
    // without a mouse.
    if (event.key === "ArrowUp" && draft === "") {
      event.preventDefault();
      onEditLast();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const left = MAX_MESSAGE_CHARS - draft.length;

  return (
    <form
      className="composer"
      data-dropping={dropping ? "true" : undefined}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      // Dropping a file on the composer is how people expect to share one, and
      // the browser's own answer to a dropped file is to navigate to it — which
      // in a webview would replace the app with somebody's photo.
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        attach([...event.dataTransfer.files]);
      }}
    >
      {replyTo ? (
        <p className="composer-reply meta">
          <span className="reply-mark">↩</span>
          <span className="reply-excerpt">{shorten(plainText(replyTo.body), 90)}</span>
          <button type="button" className="composer-reply-drop" onClick={onClearReply}>
            don’t reply
          </button>
        </p>
      ) : null}
      {problem ? <p className="composer-problem meta">{problem}</p> : null}
      {files.length === 0 ? null : (
        <ul className="composer-files">
          {files.map((one) => (
            <li key={one.key} className="composer-file" data-problem={one.problem ? "true" : undefined}>
              <span>{one.name}</span>
              {one.problem ? (
                <span>{one.problem}</span>
              ) : one.attachment ? null : (
                <span className="composer-bar" aria-label="uploading">
                  <span style={{ width: `${Math.round(one.progress * 100)}%` }} />
                </span>
              )}
              <button
                type="button"
                className="att-get"
                aria-label={`don't send ${one.name}`}
                onClick={() => drop(one.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <textarea
          ref={box}
          className="composer-input"
          rows={1}
          value={draft}
          maxLength={MAX_MESSAGE_CHARS}
          onChange={(event) => {
            setDraft(event.target.value);
            if (event.target.value !== "") startedTyping(api, room.id);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files];
            if (pasted.length > 0) {
              event.preventDefault();
              attach(pasted);
            }
          }}
          placeholder={
            replyTo
              ? "say something back"
              : isDm
                ? `say something to ${title}`
                : `say something in ${title}`
          }
          aria-label={isDm ? `message ${title}` : `message in ${title}`}
          autoComplete="off"
        />
        <button
          type="button"
          className="composer-attach"
          onClick={() => picker.current?.click()}
          aria-label="attach a file"
        >
          + file
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            attach([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          className="composer-send"
          type="submit"
          disabled={(draft.trim().length === 0 && ready.length === 0) || working}
        >
          send
        </button>
      </div>
      {/* Only near the ceiling. A counter that is always on is a scold. */}
      {left <= 200 ? (
        <p className="composer-room meta">{left} characters left</p>
      ) : null}
    </form>
  );
}

/**
 * Grow a textarea to fit what is in it, up to the height CSS allows.
 *
 * Resetting to `auto` first is the whole trick: `scrollHeight` is the content's
 * height *or* the box's, whichever is larger, so measuring without collapsing
 * it first means the box can grow and never shrink.
 */
function useAutoGrow(box: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [box, value]);
}

/**
 * Who is writing something, above the composer.
 *
 * Nobody sends a "stopped typing" — the signal goes stale instead — so this
 * checks the clock on its own rather than waiting for a frame that is never
 * coming. Two seconds is under the six the signal lives for, so the line
 * disappears within a beat of the person stopping.
 */
function Typing({
  api,
  roomId,
  people,
}: {
  api: AuthedApi;
  roomId: string;
  people: Map<string, User>;
}) {
  const gateway = useGateway(api.baseUrl);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(timer);
  }, []);

  const names = typistsIn(gateway, roomId, now).map(
    (id) => people.get(id)?.display_name ?? "someone",
  );
  // The line holds its space whether or not anyone is typing. A row that
  // appears and disappears would shove the composer up and down while you are
  // aiming at it.
  return (
    <p className="typing meta" aria-live="polite">
      {names.length === 0 ? "" : `${listOf(names)} ${names.length === 1 ? "is" : "are"} typing…`}
    </p>
  );
}

function listOf(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  if (names.length > 3) return `${names.length} people`;
  const last = names[names.length - 1] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${last}`;
}


