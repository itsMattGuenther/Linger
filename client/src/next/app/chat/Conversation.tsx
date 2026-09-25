import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkPreview } from "../../../generated/LinkPreview";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { useResizeAnchor } from "../../../lib/resize";
import { sessionLabel } from "../../../lib/time";
import { type ChatRow, chatRows, rowIndex } from "../../core/chat/rows";
import { Button } from "../../kit";
import { type MessageActions, MessageRow } from "./MessageRow";
import type { MentionLookup } from "./MessageText";
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
 * a seatbelt. Today's client learned each of the three (`Stream.tsx`).
 */
const JUMP_STILL_FRAMES = 5;
const JUMP_MIN_FRAMES = 20;
const JUMP_MAX_FRAMES = 90;
/** How long a message you jumped to stays marked. */
const FLASH_MS = 1600;

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
  me: User | null;
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
  const rows = useMemo(() => chatRows(messages, pending, { atStart, leftOff }), [messages, pending, atStart, leftOff]);
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
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

  const scroller = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    anchorTo: "end",
    followOnAppend: true,
    // React 19 refuses a synchronous flush from inside the commit that
    // measured a row; the landing and follow loops re-aim each frame anyway.
    useFlushSync: false,
  });
  useResizeAnchor(scroller, virtualizer, id, rows.length, atEnd);

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
        setLanded((count) => count + 1);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [id, rows.length, land.ready, land.at, atEnd, virtualizer, props.goTo]);

  // Follow a new last message down, only when the bottom is where you are.
  // Keyed on the last row, so history loading above never triggers it.
  const lastKey = rows[rows.length - 1]?.key;
  useEffect(() => {
    const element = scroller.current;
    if (!element || rows.length === 0 || !landing.current.done || !atEnd || jumping.current) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > BOTTOM_MARGIN_PX) return;
    let frames = 0;
    let frame = 0;
    const step = () => {
      virtualizer.scrollToIndex(rowsNow.current.length - 1, { align: "end" });
      const drawn = virtualizer.getVirtualItems();
      frames += 1;
      if (drawn[drawn.length - 1]?.index === rowsNow.current.length - 1 || frames >= 30) return;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // Deliberately keyed on the last row only: a re-render, or history
    // arriving above, must never pull the view down.
  }, [lastKey]);

  // Something growing inside the conversation while you're at its end (an
  // edit box opening, a link card arriving) keeps the end in view. The
  // virtualizer means to do this itself, but it scrolls before the list has
  // grown and the browser clamps the scroll to the old height.
  const rowsBox = useRef<HTMLDivElement | null>(null);
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
  useEffect(() => {
    noteSeen();
    window.addEventListener("focus", noteSeen);
    return () => window.removeEventListener("focus", noteSeen);
  }, [noteSeen, landed]);

  const trimTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(trimTimer.current), [id]);
  const { onNearStart, onNearEnd, onLetGo } = props;
  const letGo = useCallback(() => {
    if (!landing.current.done || jumping.current) return;
    const range = virtualizer.range;
    if (!range) return;
    let first: MessageId | null = null;
    let last: MessageId | null = null;
    for (let index = range.startIndex; index <= range.endIndex; index += 1) {
      const row = rowsNow.current[index];
      if (row?.kind !== "message" || row.pending) continue;
      first ??= row.message.id;
      last = row.message.id;
    }
    if (first !== null && last !== null) onLetGo(first, last);
  }, [virtualizer, onLetGo]);

  // Near an edge of what's held: ask for more. Checked on every scroll, and
  // once when landing ends, since someone may have scrolled while it ran.
  const checkEdges = useCallback(() => {
    const element = scroller.current;
    if (!element || !landing.current.done || jumping.current) return;
    if (element.scrollTop <= BACKFILL_MARGIN_PX && !atStart) onNearStart();
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
    <div className="nx-conv">
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
          <div ref={rowsBox} className="nx-conv-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  className="nx-conv-row"
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <RowView
                    row={row}
                    people={people}
                    byId={byId}
                    me={me}
                    now={now}
                    editing={props.editing}
                    flash={flash}
                    previews={props.previews}
                    mentions={mentions}
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

function RowView({
  row,
  people,
  byId,
  me,
  now,
  editing,
  flash,
  previews,
  mentions,
  mediaUrl,
  actions,
}: {
  row: ChatRow;
  people: ReadonlyMap<string, User>;
  byId: ReadonlyMap<MessageId, Message>;
  me: User | null;
  now: number;
  editing: MessageId | null;
  flash: MessageId | null;
  previews: Readonly<Record<string, LinkPreview>>;
  mentions: MentionLookup;
  mediaUrl: (path: string) => string;
  actions: MessageActions;
}) {
  switch (row.kind) {
    case "divider":
      return (
        <p className="nx-divider">
          <span className="nx-divider-label">{sessionLabel(row.at, now)}</span>
        </p>
      );
    case "left-off":
      // The whole of what replaces an unread badge (SPEC §4.2).
      return (
        <p className="nx-left-off">
          <span className="nx-left-off-label">you left off here</span>
        </p>
      );
    case "message": {
      const { message } = row;
      const quoted = message.reply_to === null ? undefined : byId.get(message.reply_to);
      return (
        <MessageRow
          message={message}
          head={row.head}
          pending={row.pending}
          author={people.get(message.author_id)}
          quoted={quoted}
          quotedAuthor={quoted ? people.get(quoted.author_id) : undefined}
          me={me}
          canDelete={me !== null && (message.author_id === me.id || me.is_host)}
          now={now}
          editing={editing === message.id}
          flashing={flash === message.id}
          previews={previews}
          mentions={mentions}
          mediaUrl={mediaUrl}
          actions={actions}
        />
      );
    }
  }
}
