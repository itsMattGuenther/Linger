import { defaultRangeExtractor, measureElement, type Range, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LinkPreview } from "../../../generated/LinkPreview";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { nameless } from "../../../lib/gone";
import { mayActOn } from "../../../lib/host";
import { useResizeAnchor } from "../../../lib/resize";
import { sessionLabel } from "../../../lib/time";
import { type ChatRow, chatRows, rowIndex, sameRow } from "../../core/chat/rows";
import { observeScrollNow } from "../../core/chat/scrollWatch";
import { Button, Icon } from "../../kit";
import { JoinLine } from "./JoinLine";
import { LeftLine } from "./LeftLine";
import { PollClosedLine } from "./PollClosedLine";
import { onIPhone, onPhone } from "../../core/phone";
import { type MessageActions, MessageRow } from "./MessageRow";
import type { CustomEmojiByName, MentionLookup } from "./MessageText";
import "./Conversation.css";

/** Start fetching older history this close to the top: about two screens. */
const BACKFILL_MARGIN_PX = 1200;
/** How long scrolling must stop before far-off history is let go of (#173). */
const TRIM_IDLE_MS = 600;
/** A couple of lines of slack: a scroll a pixel short still sees the end. */
const BOTTOM_MARGIN_PX = 48;
/** A one-line continuation is 24px (SPEC §4.7). Every row is measured once drawn. */
const ESTIMATE_PX = 24;
/**
 * How a landing or a jump knows it has arrived. Rows are estimates until drawn, so a jump
 * re-aims every frame until the aim and the measured height both hold still,
 * after a floor of frames for the first measurements to land, with a cap as
 * a seatbelt. The previous client learned each of the three.
 */
const JUMP_STILL_FRAMES = 5;
const JUMP_MIN_FRAMES = 20;
const JUMP_MAX_FRAMES = 90;
/** Following a new message down: the same, without the floor, and shorter (#625). */
const FOLLOW_STILL_FRAMES = 3;
const FOLLOW_MAX_FRAMES = 30;
/** How long a message you jumped to stays marked. */
const FLASH_MS = 1600;
/** Rows drawn beyond either edge of the screen. */
const OVERSCAN = 12;
/** How far above the screen rows are measured ahead of a glide: a page of history and its dividers (#698). */
const MEASURE_AHEAD = 150;
/**
 * On an iPhone, how long after a finger lifts the conversation still counts
 * as moving: the virtualizer holds its corrections back for 150 ms after
 * one lifts, and as long after the last scroll (#698).
 */
const LIFT_MS = 200;

export interface ConversationProps {
  /** The conversation's id. A new id starts over: landing, jumps, marks. */
  id: string;
  /** The log's accessible name: "messages in #general", "messages with Jules". */
  label: string;
  /** Confirmed messages, oldest first. */
  messages: readonly Message[];
  /** Sends still waiting on the server, drawn after the confirmed ones. */
  pending: readonly Message[];
  /** The oldest message held is the first ever said here. */
  atStart: boolean;
  /** The newest message held is the newest there is (false in a window around a search hit). */
  atEnd: boolean;
  /** The newest message read when the conversation was opened: where the line goes. */
  leftOff: MessageId | null;
  /**
   * Where to land once the history is in: the "you left off here" line, or
   * the newest message. `ready` is false while the first page is loading.
   */
  land: { ready: boolean; at: "left-off" | "end" };
  people: ReadonlyMap<string, User>;
  /** Deleted accounts (#650): what they left says "Deleted account". */
  gone?: ReadonlySet<string>;
  me: User | null;
  /**
   * Who you've blocked (PROTOCOL §5): each of their messages is drawn as one
   * grey line, and opens where it is when asked. Folding them away entirely
   * would leave replies to them answering nothing (SPEC §4.15).
   */
  blocked?: ReadonlySet<string>;
  /** The server's own emoji (#359), drawn for their `:name:`. */
  customEmoji?: readonly CustomEmoji[];
  now: number;
  previews: Readonly<Record<string, LinkPreview>>;
  mediaUrl: (path: string) => string;
  /** The message being edited in place, if any. */
  editing: MessageId | null;
  /** A message to go to, from outside (a search hit, a media item). */
  goTo?: MessageId | null;
  onWentTo?: (found: boolean) => void;
  /** What an empty conversation says. */
  empty: string;
  /** The top of what's held is near: load older. */
  onNearStart: () => void;
  /** The bottom of a historical window is near: load newer. */
  onNearEnd: () => void;
  /** The newest message is on screen. The window decides whether that counts as read. */
  onSeenNewest: (id: MessageId) => void;
  /** Scrolling stopped: everything outside first…last may be let go (#173). */
  onLetGo: (first: MessageId, last: MessageId) => void;
  /** "Back to the newest", out of a historical window. */
  onBackToNewest: () => void;
  actions: Omit<MessageActions, "jumpTo">;
}

/**
 * A conversation's messages: virtualized from day one (AGENTS), hanging from
 * the bottom, landing on "you left off here" or the newest, following new
 * messages only when you're at the end, and never moving someone reading
 * older ones (SPEC §4.2). The window wires it to the store; it holds no data.
 */
export const Conversation = memo(function Conversation(props: ConversationProps) {
  const { id, messages, pending, atStart, atEnd, leftOff, land, people, me, now } = props;
  const scroller = useRef<HTMLDivElement | null>(null);
  // The virtualizer as of the last render: whether something is scrolling
  // the conversation, and which rows it has measured.
  const measures = useRef<Pick<Virtualizer<HTMLDivElement, Element>, "isScrolling" | "itemSizeCache" | "range"> | null>(null);
  const finger = useRef({ down: false, lifted: Number.NEGATIVE_INFINITY });
  const [woken, wake] = useReducer((count: number) => count + 1, 0);

  // On an iPhone, the page can't move the scroll position while the
  // conversation is moving: WebKit stops the glide dead. So the virtualizer
  // holds back every correction until it's still, and what changed above
  // the reader meanwhile moved what they were reading. A page of older
  // history arriving mid-glide threw the view a whole page, further with
  // each page (#698). There, older history waits out of sight until the
  // conversation is still, and goes in then, corrected as it arrives.
  const holdOlder = onIPhone();
  /** Nothing is scrolling the conversation, and on an iPhone no finger is on it or has only just left it. */
  const still = useCallback(
    () => !(measures.current?.isScrolling ?? false) && (!holdOlder || (!finger.current.down && performance.now() - finger.current.lifted >= LIFT_MS)),
    [holdOlder],
  );
  const oldestShown = useRef<MessageId | null>(null);
  const holdFrom =
    holdOlder && oldestShown.current !== null && messages[0]?.id !== oldestShown.current && !still()
      ? Math.max(0, messages.findIndex((message) => message.id === oldestShown.current))
      : 0;
  const listed = useMemo(() => (holdFrom === 0 ? messages : messages.slice(holdFrom)), [messages, holdFrom]);
  oldestShown.current = listed[0]?.id ?? null;
  const holding = holdFrom > 0;
  const holdingNow = useRef(holding);
  holdingNow.current = holding;

  const rows = useMemo(() => chatRows(listed, pending, { atStart: atStart && !holding, leftOff }), [listed, pending, atStart, holding, leftOff]);
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  const idNow = useRef(id);
  idNow.current = id;
  const indexOf = useMemo(() => rowIndex(rows), [rows]);
  const indexNow = useRef(indexOf);
  indexNow.current = indexOf;
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);

  const byHandle = useMemo(() => new Map([...people.values()].map((person) => [person.username, person])), [people]);
  const mentions = useCallback<MentionLookup>(
    (handle) => {
      const person = byHandle.get(handle);
      return person === undefined ? null : { name: person.display_name, me: person.id === me?.id };
    },
    [byHandle, me?.id],
  );

  const emojiByName = useMemo<CustomEmojiByName>(() => new Map((props.customEmoji ?? []).map((one) => [one.name, one])), [props.customEmoji]);

  // Rows above the screen are measured while the conversation is still,
  // not when a glide reaches them (#698). A row's real height moves what's
  // under it, which the virtualizer makes up for by correcting the scroll
  // position: unseen at rest, but in the middle of a glide an iPhone holds
  // the correction back until it stops, and the glide ended in a jump. So
  // once it's still, rows above that have never been drawn are drawn,
  // out of sight, to be measured, and go again before the frame is painted
  // ("Measuring ahead", below, says when).
  const [aheadToo, setAheadToo] = useState(false);
  /**
   * Every row measured, by conversation and key. The virtualizer keeps a
   * size only when it differs from the estimate, so a row exactly
   * `ESTIMATE_PX` tall (a one-line message under the one before) looked
   * never measured, and was drawn again to be measured at every stop:
   * about a hundred rows each time (#709).
   */
  const measured = useRef(new Set<string>());
  /** Rows above `top` and near it that have never been drawn. */
  const unmeasuredAbove = useCallback((top: number) => {
    const sizes = measures.current?.itemSizeCache;
    const unmeasured: number[] = [];
    for (let index = Math.max(0, top - MEASURE_AHEAD); sizes && index < top; index += 1) {
      const key = rowsNow.current[index]?.key;
      if (key !== undefined && !sizes.has(key) && !measured.current.has(`${idNow.current} ${key}`)) unmeasured.push(index);
    }
    return unmeasured;
  }, []);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const near = defaultRangeExtractor(range);
      const top = near[0];
      return aheadToo && top !== undefined ? [...unmeasuredAbove(top), ...near] : near;
    },
    [aheadToo, unmeasuredAbove],
  );
  // Drawn only to be measured, which they were as they were drawn: gone
  // again before the frame is painted.
  useLayoutEffect(() => {
    if (aheadToo) setAheadToo(false);
  }, [aheadToo]);

  // Follow what arrives at the bottom only while the room holds its newest
  // messages, and held them at the last render too. Reading forwards out of
  // history adds a page at a time at the bottom; followed, each page moved
  // the view to the new bottom, which asked for the next, and a reader was
  // carried to the newest in half a second (#369). The page that makes the
  // room whole again leaves them where they are too.
  const heldNewest = useRef(atEnd);
  useEffect(() => {
    heldNewest.current = atEnd;
  }, [atEnd]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN,
    anchorTo: "end",
    followOnAppend: atEnd && heldNewest.current,
    // React 19 refuses a synchronous flush from inside the commit that
    // measured a row; the landing and follow loops re-aim each frame anyway.
    useFlushSync: false,
    // The virtualizer places the rows and sizes their box itself, in the
    // same moment it corrects the scroll for a row above that turned out
    // taller than its estimate. Left to React's next render, the correction
    // was painted a frame before the rows moved: everything jumped back by
    // the difference and forward again, which a glide shows as a skip once
    // it has slowed down (#698).
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    rangeExtractor,
    // Where the conversation is when scrolling stops, not where it was at
    // the last scroll event: a page of history may have moved it since (#716).
    observeElementOffset: observeScrollNow,
    // Noted as measured whatever the size, for measuring ahead (above).
    measureElement: (element, entry, instance) => {
      const key = element.getAttribute("data-key");
      if (key !== null) measured.current.add(`${idNow.current} ${key}`);
      return measureElement(element, entry, instance);
    },
  });
  measures.current = virtualizer;
  useResizeAnchor(scroller, virtualizer, id, rows.length, atEnd);

  // A finger on the conversation, for `still`: on an iPhone the virtualizer
  // holds corrections back while one is down and for a moment after, and
  // history held meanwhile goes in once it has been off long enough.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !holdOlder) return;
    let timer = 0;
    const down = () => {
      finger.current = { down: true, lifted: finger.current.lifted };
      window.clearTimeout(timer);
    };
    const up = () => {
      finger.current = { down: false, lifted: performance.now() };
      window.clearTimeout(timer);
      timer = window.setTimeout(wake, LIFT_MS + 16);
    };
    element.addEventListener("touchstart", down, { passive: true });
    element.addEventListener("touchend", up, { passive: true });
    element.addEventListener("touchcancel", up, { passive: true });
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("touchstart", down);
      element.removeEventListener("touchend", up);
      element.removeEventListener("touchcancel", up);
    };
  }, [holdOlder]);

  // Somebody taking hold of the conversation ends any aiming at a row the
  // page left behind (`stopAiming`); the follow below stops its own the
  // same way.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const hold = () => stopAiming(virtualizer);
    const kinds = ["touchstart", "wheel", "pointerdown", "keydown"] as const;
    for (const kind of kinds) element.addEventListener(kind, hold, { passive: true });
    return () => {
      for (const kind of kinds) element.removeEventListener(kind, hold);
    };
  }, [virtualizer]);

  // Landing: once per conversation, on the line or the bottom. Rows are
  // estimates until drawn, so aim every frame until the target holds still.
  const landing = useRef({ id: "", done: false });
  const jumping = useRef(false);
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (rows.length === 0 || !land.ready || props.goTo) return;
    if (landing.current.id !== id) landing.current = { id, done: false };
    if (landing.current.done) return;
    const toLine = land.at === "left-off" && rows.some((row) => row.kind === "left-off");
    if (!atEnd && !toLine) return;
    let frames = 0;
    let stable = 0;
    let total = -1;
    let frame = 0;
    const step = () => {
      if (landing.current.done) return;
      const target = toLine ? rowsNow.current.findIndex((row) => row.kind === "left-off") : rowsNow.current.length - 1;
      if (target < 0) return;
      virtualizer.scrollToIndex(target, { align: toLine ? "start" : "end" });
      const element = scroller.current;
      const size = virtualizer.getTotalSize();
      const drawn = virtualizer.getVirtualItems().find((item) => item.index === target);
      const there = toLine
        ? drawn !== undefined && Math.abs(drawn.start - (virtualizer.scrollOffset ?? 0)) < 2
        : element !== null && element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
      stable = there && size === total ? stable + 1 : 0;
      total = size;
      frames += 1;
      if ((there && stable >= JUMP_STILL_FRAMES && (!toLine || frames >= JUMP_MIN_FRAMES)) || frames >= JUMP_MAX_FRAMES) {
        landing.current.done = true;
        stopAiming(virtualizer);
        setLanded((count) => count + 1);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [id, rows.length, land.ready, land.at, atEnd, virtualizer, props.goTo]);

  // Measuring ahead (above), and when: once nothing scrolls the
  // conversation, in a frame, after its scroll events, so the virtualizer
  // corrects from where the conversation really is, and synchronously, so
  // nothing can scroll it between the rows being drawn and measured. A render
  // left to run later could land between somebody's scroll and its event, and
  // the correction put the view back where it had been.
  const scrolling = virtualizer.isScrolling;
  useEffect(() => {
    if (scrolling) return;
    const frame = requestAnimationFrame(() => {
      const range = measures.current?.range;
      if (!range || !landing.current.done || jumping.current || !still()) return;
      if (unmeasuredAbove(Math.max(0, range.startIndex - OVERSCAN)).length > 0) flushSync(() => setAheadToo(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, scrolling, landed, woken, still, unmeasuredAbove]);

  // Follow a new last message down, only when the bottom is where you were.
  // Keyed on the last row, so history loading above never triggers it.
  //
  // Judged by the row that was last until now, not by the distance to the new
  // bottom: that distance includes the new rows' own height, measured as they
  // mount. The virtualizer follows by itself only from within a pixel of the
  // end. From anywhere else in the margin (a scroll a few pixels short, or the
  // frame where something above changed size, a link card landing), a message
  // taller than the margin was left below the fold and never marked read (#625).
  const lastKey = rows[rows.length - 1]?.key;
  const lastKeyBefore = useRef(lastKey);
  const seenNow = useRef<() => void>(() => {});
  useEffect(() => {
    const before = lastKeyBefore.current;
    lastKeyBefore.current = lastKey;
    const element = scroller.current;
    if (!element || rows.length === 0 || !landing.current.done || !atEnd || jumping.current) return;
    // The row that was last, if it's still drawn. A sent message replaced by
    // the server's copy isn't, and the distance to the bottom judges instead.
    const wasLast = before === undefined ? null : element.querySelector(`[data-key="${CSS.escape(before)}"]`);
    const below = wasLast
      ? wasLast.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
      : element.scrollHeight - element.scrollTop - element.clientHeight;
    if (below > BOTTOM_MARGIN_PX) return;
    // Aim at the end every frame until it holds still: rows are measured, and
    // anything above settles, a frame or two after they're drawn. Somebody
    // reaching for the conversation meanwhile takes it back at once.
    let frames = 0;
    let stable = 0;
    let total = -1;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", stop);
      element.removeEventListener("touchstart", stop);
      element.removeEventListener("pointerdown", stop);
      element.removeEventListener("keydown", stop);
    };
    const step = () => {
      virtualizer.scrollToIndex(rowsNow.current.length - 1, { align: "end" });
      const size = virtualizer.getTotalSize();
      const there = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
      stable = there && size === total ? stable + 1 : 0;
      total = size;
      frames += 1;
      if (stable >= FOLLOW_STILL_FRAMES || frames >= FOLLOW_MAX_FRAMES) {
        stop();
        // Arriving needn't scroll (the virtualizer may already have), so say
        // the newest is in view here rather than wait for a scroll event.
        seenNow.current();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("touchstart", stop, { passive: true });
    element.addEventListener("pointerdown", stop, { passive: true });
    element.addEventListener("keydown", stop);
    frame = requestAnimationFrame(step);
    return stop;
    // Deliberately keyed on the last row only: a re-render, or history
    // arriving above, must never pull the view down.
  }, [lastKey]);

  // Something growing inside the conversation while you're at its end (an
  // edit box opening, a link card arriving) keeps the end in view. The
  // virtualizer means to do this itself, but it scrolls before the list has
  // grown and the browser clamps the scroll to the old height.
  const rowsBox = useRef<HTMLDivElement | null>(null);
  const { containerRef } = virtualizer;
  const rowsRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowsBox.current = node;
      containerRef(node);
    },
    [containerRef],
  );
  const atEndNow = useRef(atEnd);
  atEndNow.current = atEnd;
  const drawn = rows.length > 0;
  useEffect(() => {
    const element = scroller.current;
    const inner = rowsBox.current;
    if (!element || !inner) return;
    const gap = () => element.scrollHeight - element.scrollTop - element.clientHeight;
    let pinned = gap() <= 2;
    const remember = () => {
      pinned = gap() <= 2;
    };
    const observer = new ResizeObserver(() => {
      if (!pinned || !atEndNow.current || !landing.current.done || jumping.current) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(inner);
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", remember);
    };
  }, [drawn]);

  // Read is the window's call (it knows whether it has your attention); this
  // only says when the newest message is on screen at the live end.
  const onSeenNewest = props.onSeenNewest;
  const noteSeen = useCallback(() => {
    const element = scroller.current;
    const newest = messages[messages.length - 1];
    if (!element || newest === undefined || !landing.current.done || jumping.current || !atEnd) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > BOTTOM_MARGIN_PX) return;
    onSeenNewest(newest.id);
  }, [messages, atEnd, onSeenNewest]);
  seenNow.current = noteSeen;
  useEffect(() => {
    noteSeen();
    window.addEventListener("focus", noteSeen);
    return () => window.removeEventListener("focus", noteSeen);
  }, [noteSeen, landed]);

  const trimTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(trimTimer.current), [id]);
  const { onNearStart, onNearEnd, onLetGo } = props;
  const letGo = useCallback(() => {
    // Letting go above moves the rows the way a page arriving does, so it
    // waits for the same stillness (above): on an iPhone, a finger off it too.
    // The next scroll that stops tries again.
    if (!landing.current.done || jumping.current || !still()) return;
    const range = virtualizer.range;
    if (!range) return;
    let first: MessageId | null = null;
    let last: MessageId | null = null;
    for (let index = range.startIndex; index <= range.endIndex; index += 1) {
      const row = rowsNow.current[index];
      if (row?.kind === "joins") {
        first ??= row.messages[0]?.id ?? null;
        last = row.messages[row.messages.length - 1]?.id ?? last;
        continue;
      }
      if (row?.kind !== "message" || row.pending) continue;
      first ??= row.message.id;
      last = row.message.id;
    }
    if (first !== null && last !== null) onLetGo(first, last);
  }, [virtualizer, onLetGo, still]);

  // Near an edge of what's held: ask for more. Checked on every scroll, and
  // once when landing ends, since someone may have scrolled while it ran.
  // Not for older while a page of it is waiting to go in (above): each would
  // be the next page, and the next, without anybody having reached them.
  const checkEdges = useCallback(() => {
    const element = scroller.current;
    if (!element || !landing.current.done || jumping.current) return;
    if (element.scrollTop <= BACKFILL_MARGIN_PX && !atStart && !holdingNow.current) onNearStart();
    const below = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (below <= BACKFILL_MARGIN_PX && !atEnd) onNearEnd();
  }, [atStart, atEnd, onNearStart, onNearEnd]);

  const onScroll = useCallback(() => {
    noteSeen();
    window.clearTimeout(trimTimer.current);
    trimTimer.current = window.setTimeout(letGo, TRIM_IDLE_MS);
    checkEdges();
  }, [noteSeen, letGo, checkEdges]);

  // After landing, and whenever what's held changes: an edge that is already
  // in reach (or a first page too short to scroll) loads the next page.
  useEffect(checkEdges, [landed, rows.length, checkEdges]);

  const [flash, setFlash] = useState<MessageId | null>(null);
  // Blocked people's messages opened anyway, this time round (PROTOCOL §5).
  const [shown, setShown] = useState<ReadonlySet<MessageId>>(() => new Set());
  const show = useCallback((id: MessageId) => setShown((held) => new Set(held).add(id)), []);
  useEffect(() => setFlash(null), [id]);
  const jumpTo = useCallback(
    (target: MessageId): boolean => {
      if (indexNow.current.get(target) === undefined) return false;
      landing.current = { id, done: true };
      jumping.current = true;
      let frames = 0;
      let still = 0;
      let aim = -1;
      let height = -1;
      const step = () => {
        const index = indexNow.current.get(target);
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
        const row = virtualizer.getVirtualItems().find((one) => one.index === index);
        const view = scroller.current;
        const onScreen = row !== undefined && view !== null && row.end - offset > 0 && row.start - offset < view.clientHeight;
        if ((onScreen && still >= JUMP_STILL_FRAMES && frames >= JUMP_MIN_FRAMES) || frames >= JUMP_MAX_FRAMES) {
          jumping.current = false;
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setFlash(target);
      window.setTimeout(() => setFlash((current) => (current === target ? null : current)), FLASH_MS);
      return true;
    },
    [id, virtualizer],
  );

  const { goTo, onWentTo } = props;
  useEffect(() => {
    if (!goTo) return;
    const found = jumpTo(goTo);
    onWentTo?.(found);
  }, [goTo, jumpTo, onWentTo]);

  const actions = useMemo<MessageActions>(
    () => ({
      ...props.actions,
      jumpTo: (target: MessageId) => {
        jumpTo(target);
      },
    }),
    [props.actions, jumpTo],
  );

  const items = virtualizer.getVirtualItems();
  return (
    <div className="nx-conv" data-react={props.actions.react && !onPhone() ? "yes" : undefined}>
      <div
        ref={scroller}
        className="nx-conv-scroll"
        role="log"
        aria-label={props.label}
        // Busy while it lands, so a screen reader isn't read the whole page
        // of history it just drew.
        aria-busy={rows.length > 0 && !landing.current.done ? true : undefined}
        tabIndex={0}
        onScroll={onScroll}
      >
        {rows.length === 0 ? (
          <p className="nx-conv-empty">{land.ready && atStart ? props.empty : ""}</p>
        ) : (
          // Its height and the rows' places are the virtualizer's to write
          // (directDomUpdates, above).
          <div ref={rowsRef} className="nx-conv-rows">
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div key={item.key} className="nx-conv-row" data-index={item.index} data-key={item.key} ref={virtualizer.measureElement}>
                  <RowView
                    row={row}
                    people={people}
                    gone={props.gone}
                    quoted={row.kind === "message" && row.message.reply_to !== null ? byId.get(row.message.reply_to) : undefined}
                    me={me}
                    blocked={props.blocked}
                    shown={row.kind === "message" && shown.has(row.message.id)}
                    onShow={show}
                    now={now}
                    editing={row.kind === "message" && props.editing === row.message.id}
                    flash={row.kind === "message" && flash === row.message.id}
                    previews={props.previews}
                    mentions={mentions}
                    emoji={emojiByName}
                    mediaUrl={props.mediaUrl}
                    actions={actions}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {atEnd ? null : (
        <div className="nx-conv-newest">
          <Button size="sm" variant="secondary" icon="down" onClick={props.onBackToNewest}>
            Back to the newest
          </Button>
        </div>
      )}
    </div>
  );
});

interface RowViewProps {
  row: ChatRow;
  people: ReadonlyMap<string, User>;
  gone: ReadonlySet<string> | undefined;
  /** The message a reply quotes, when it's held. */
  quoted: Message | undefined;
  me: User | null;
  blocked: ReadonlySet<string> | undefined;
  /** A message from somebody blocked that was opened anyway. */
  shown: boolean;
  onShow: (id: MessageId) => void;
  now: number;
  /** This row's message is being edited in place. */
  editing: boolean;
  /** This row's message was just jumped to, and is marked. */
  flash: boolean;
  previews: Readonly<Record<string, LinkPreview>>;
  mentions: MentionLookup;
  emoji: CustomEmojiByName;
  mediaUrl: (path: string) => string;
  actions: MessageActions;
}

function sameRowView(a: RowViewProps, b: RowViewProps): boolean {
  for (const key of Object.keys(a) as (keyof RowViewProps)[]) {
    if (key === "row" ? !sameRow(a.row, b.row) : a[key] !== b[key]) return false;
  }
  return true;
}

const RowView = memo(function RowView({
  row,
  people,
  gone,
  quoted,
  me,
  blocked,
  shown,
  onShow,
  now,
  editing,
  flash,
  previews,
  mentions,
  emoji,
  mediaUrl,
  actions,
}: RowViewProps) {
  switch (row.kind) {
    case "divider": {
      // A session that starts at a time that can't be drawn has no words to
      // say when, so it draws no divider (#509).
      const label = sessionLabel(row.at, now);
      return label === "" ? null : (
        <p className="nx-divider">
          <span className="nx-divider-label">{label}</span>
        </p>
      );
    }
    case "joins": {
      // Somebody joining voice (#473). Nobody you blocked is in it: their
      // arriving isn't news you asked for (PROTOCOL §5).
      const joined = blocked === undefined ? row.messages : row.messages.filter((message) => !blocked.has(message.author_id));
      return joined.length > 0 ? <JoinLine messages={joined} people={people} gone={gone} /> : null;
    }
    case "left-off":
      // The whole of what replaces an unread badge (SPEC §4.2).
      return (
        <p className="nx-left-off">
          <span className="nx-left-off-label">you left off here</span>
        </p>
      );
    case "message": {
      const { message } = row;
      // A poll closing (#474): a quiet line saying how it came out, with a
      // way back up to it.
      if (message.poll_closed != null && message.deleted_at === null) {
        return <PollClosedLine message={message} closed={message.poll_closed} onJump={actions.jumpTo} />;
      }
      // Somebody leaving a group DM (#565): a quiet line saying who. Shown
      // even for somebody you blocked: it's who can still read what you say.
      if (message.left === true) return <LeftLine message={message} person={people.get(message.author_id)} gone={gone} />;
      if (blocked?.has(message.author_id) && message.deleted_at === null && !shown) {
        return <BlockedLine who={people.get(message.author_id)?.display_name ?? nameless(message.author_id, gone)} onShow={() => onShow(message.id)} />;
      }
      return (
        <MessageRow
          message={message}
          head={row.head}
          pending={row.pending}
          author={people.get(message.author_id)}
          quoted={quoted}
          quotedAuthor={quoted ? people.get(quoted.author_id) : undefined}
          me={me}
          canDelete={me !== null && (message.author_id === me.id || mayActOn(me, people.get(message.author_id)))}
          now={now}
          editing={editing}
          flashing={flash}
          previews={previews}
          mentions={mentions}
          emoji={emoji}
          mediaUrl={mediaUrl}
          actions={actions}
          people={people}
          gone={gone}
        />
      );
    }
  }
}, sameRowView);

/**
 * Stop the virtualizer aiming at a row it was sent to (`scrollToIndex`). It
 * keeps at it for up to five seconds whatever the reader does meanwhile, and
 * when that row moved, a page going in above or a row above measured, it
 * pulled the view back to it (#698): the landing's last row, a page later,
 * was 600px up a page of older history. It has no way to stop but this: its
 * public ways all write a scroll position, which at the bottom is the
 * scroller's padding short, and at a touch could undo a frame of a glide.
 */
function stopAiming(virtualizer: object) {
  if ("scrollState" in virtualizer) (virtualizer as { scrollState: unknown }).scrollState = null;
}

/**
 * A message from somebody you blocked (PROTOCOL §5, SPEC §4.15): one grey
 * line in its place, which opens it where it is. Their name is said, so a
 * reply to them still makes sense.
 */
function BlockedLine({ who, onShow }: { who: string; onShow: () => void }) {
  return (
    <button type="button" className="nx-msg-blocked" onClick={onShow} aria-label={`A message from ${who}, who you blocked. Show it.`}>
      <Icon name="block" size="sm" />
      <span className="nx-msg-blocked-who">From {who}, who you blocked</span>
      <span className="nx-msg-blocked-show">Show</span>
    </button>
  );
}
