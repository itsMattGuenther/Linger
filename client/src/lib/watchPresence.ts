/**
 * Watch the window, send `room.focus`, `idle` and `away`.
 *
 * The clocks and the deciding live in `presence.ts`. This file is the part
 * that cannot be tested without a window: it listens for input and focus,
 * holds the last thing we sent, and talks to the gateway.
 *
 * There is one window and there can be several servers (T-412), so the two
 * halves are split. Focus and the last keystroke are global — they are facts
 * about the person, not about a connection. Everything that was last *said* to
 * a server is per server, in a `Watch`, because each connection has its own
 * presence map and forgets it on every reconnect.
 *
 * You are in at most one room anywhere, so `setPresenceRoom` puts you in a room
 * on one server and takes you out of the room on all the others. Switching
 * servers in the rail is what that is for: the room you left stops showing you
 * standing in it.
 */
import type { PresenceState } from "../generated/PresenceState";
import type { RoomId } from "../generated/RoomId";
import { send } from "./gateway";
import { readFocused, setLooking, stopLooking } from "./looking";
import { decide, frameFor, nextCheckAt, type PresenceAction, type PresenceClock } from "./presence";

interface Sent {
  roomId: RoomId | null;
  state: PresenceState;
  awayMessage: string | null;
}

function applySent(sent: Sent, action: PresenceAction): Sent {
  if (action.kind === "focus") {
    return {
      roomId: action.roomId,
      state: action.roomId === null ? "around" : "in_room",
      // The server clears the away message on any `room.focus`, so our record
      // of what is on the wire has to clear with it.
      awayMessage: null,
    };
  }
  if (action.kind === "away") {
    return { roomId: sent.roomId, state: "away", awayMessage: action.message };
  }
  return { roomId: sent.roomId, state: action.state, awayMessage: null };
}

/** What we have said to one server, and what we want it to hear next. */
interface Watch {
  live: boolean;
  openRoomId: RoomId | null;
  sentRoomId: RoomId | null;
  sentState: PresenceState;
  sentAwayMessage: string | null;
  wantAway: string | null;
  timer: number | null;
  running: boolean;
  pending: boolean;
}

const watches = new Map<string, Watch>();

function watchFor(server: string): Watch {
  const held = watches.get(server);
  if (held !== undefined) return held;
  const fresh: Watch = {
    live: false,
    openRoomId: null,
    sentRoomId: null,
    sentState: "around",
    sentAwayMessage: null,
    wantAway: null,
    timer: null,
    running: false,
    pending: false,
  };
  watches.set(server, fresh);
  return fresh;
}

// The window's own state, shared by every server.
let focused = false;
/**
 * The app's other windows, by label, and whether each has focus: the Buddy
 * list client's chat windows report here (docs/design/architecture.md). The
 * person is at Linger when any of its windows has focus; today's client has
 * one window and never reports, so for it this stays empty.
 */
const otherWindows = new Map<string, boolean>();
let lastInputAt = 0;
let blurredAt = 0;
let attached = false;
let unlisten: (() => void) | null = null;

function clock(watch: Watch): PresenceClock {
  return {
    focused,
    lastInputAt,
    blurredAt,
    roomId: watch.openRoomId,
    sentRoomId: watch.sentRoomId,
    sentState: watch.sentState,
    wantAway: watch.wantAway,
    sentAwayMessage: watch.sentAwayMessage,
  };
}

function clearTimer(watch: Watch): void {
  if (watch.timer !== null && typeof window !== "undefined") {
    window.clearTimeout(watch.timer);
  }
  watch.timer = null;
}

function schedule(server: string, watch: Watch): void {
  if (typeof window === "undefined") return;
  clearTimer(watch);
  if (!watch.live) return;
  const at = nextCheckAt(clock(watch), Date.now());
  if (at === null) return;
  watch.timer = window.setTimeout(() => {
    watch.timer = null;
    void tick(server);
  }, Math.max(0, at - Date.now()));
}

/**
 * Work out what to send to one server, and send it. One of these runs at a
 * time per server.
 *
 * The guard is a plain boolean, and it has to be. An earlier version held the
 * in-flight promise instead, which looked equivalent and was not: when
 * `decide` has nothing to say, the whole body runs to completion *before* the
 * promise is assigned, so the assignment overwrote the `null` the body had
 * just cleared. Every later tick then saw a non-null promise, set `pending`,
 * and returned — and presence stopped sending anything at all for the rest of
 * the session. Nothing surfaced it: the frames simply stopped, and the last
 * ones sent stayed true on the server.
 *
 * A boolean set before the first statement cannot be beaten by its own body.
 * Anything that arrives mid-flight sets `pending` and the loop goes round
 * again, so a tick is never dropped.
 */
async function tick(server: string): Promise<void> {
  const watch = watches.get(server);
  if (watch === undefined) return;
  if (watch.running) {
    watch.pending = true;
    return;
  }
  watch.running = true;
  try {
    do {
      watch.pending = false;
      if (!watch.live) break;
      // One action per pass so a refused send cannot skip the next one.
      // `decide` is cheap; looping until it returns null is how "leave, then
      // go idle" happens as two frames rather than a fight.
      for (;;) {
        const action = decide(clock(watch), Date.now());
        if (action === null) break;
        const ok = await send(server, frameFor(action));
        if (!ok) break;
        const next = applySent(
          {
            roomId: watch.sentRoomId,
            state: watch.sentState,
            awayMessage: watch.sentAwayMessage,
          },
          action,
        );
        watch.sentRoomId = next.roomId;
        watch.sentState = next.state;
        watch.sentAwayMessage = next.awayMessage;
      }
      schedule(server, watch);
    } while (watch.pending && watch.live);
  } finally {
    watch.running = false;
  }
}

function tickAll(): void {
  for (const server of watches.keys()) void tick(server);
}

function anyFocused(): boolean {
  if (readFocused()) return true;
  for (const has of otherWindows.values()) if (has) return true;
  return false;
}

function syncFocus(): void {
  const next = anyFocused();
  if (next === focused) return;
  const now = Date.now();
  if (next) lastInputAt = now;
  else blurredAt = now;
  focused = next;
  setLooking(next);
}

function onInput(): void {
  lastInputAt = Date.now();
  syncFocus();
  tickAll();
}

function onFocusChange(): void {
  syncFocus();
  tickAll();
}

/**
 * Another window of the app gained or lost focus, or saw the person type or
 * move (the Buddy list client's chat windows, reported through the owner).
 * Presence then treats the app as focused if any window is, and counts input
 * in any window as the person being here.
 */
export function reportWindow(label: string, report: { focused: boolean; input?: boolean }): void {
  otherWindows.set(label, report.focused);
  if (report.input === true) lastInputAt = Date.now();
  syncFocus();
  tickAll();
}

/** A window of the app closed: it no longer counts towards being here. */
export function forgetWindow(label: string): void {
  if (!otherWindows.delete(label)) return;
  syncFocus();
  tickAll();
}

/**
 * The room on screen, and which server it belongs to. Call when either
 * changes; no-ops if nothing did.
 *
 * Every other server is taken out of its room by the same call, because you
 * are only ever standing in one place. Pass a null room to be in none.
 */
export function setPresenceRoom(server: string, roomId: RoomId | null): void {
  const watch = watchFor(server);
  let changed = watch.openRoomId !== roomId;
  watch.openRoomId = roomId;
  for (const [other, elsewhere] of watches) {
    if (other === server || elsewhere.openRoomId === null) continue;
    elsewhere.openRoomId = null;
    changed = true;
    void tick(other);
  }
  if (changed) void tick(server);
}

/**
 * Go away, or come back, on one server (SPEC §4.6). `null` is coming back.
 *
 * Only the wire half. The copy that outlives the session is saved on the
 * status by the editor, which is also what stamps `away_since` — the server
 * owns that value and only `PATCH /me` sets it.
 */
export function setAway(server: string, message: string | null): void {
  const watch = watchFor(server);
  const next = message === null || message.trim() === "" ? message : message.trim();
  if (next === watch.wantAway) return;
  watch.wantAway = next;
  void tick(server);
}

/** Whether this client currently believes it is away on one server. */
export function isAway(server: string): boolean {
  return watches.get(server)?.wantAway != null;
}

/**
 * True once one server's gateway has said `ready`. A fresh `ready` is a new
 * session as far as that server is concerned — we are `around` with no room,
 * and the next tick re-announces if we should still be in one.
 *
 * Being away survives the reconnect. The server forgot — its presence map is
 * per-connection — so `sentAwayMessage` clears and the next tick says it
 * again. A dropped socket is not somebody coming back to their desk.
 */
export function setPresenceLive(server: string, next: boolean): void {
  const watch = watchFor(server);
  if (next === watch.live) return;
  watch.live = next;
  if (next) {
    watch.sentRoomId = null;
    watch.sentState = "around";
    watch.sentAwayMessage = null;
    void tick(server);
    return;
  }
  clearTimer(watch);
}

/** Stop watching one server: it has been signed out of, or removed. */
export function dropPresence(server: string): void {
  const watch = watches.get(server);
  if (watch === undefined) return;
  clearTimer(watch);
  watches.delete(server);
}

/**
 * Start watching the window. Returns a stop function so a signed-out
 * session does not keep sending frames for connections that are gone.
 */
export function startPresence(): () => void {
  if (attached) return stopPresence;
  attached = true;
  const now = Date.now();
  lastInputAt = now;
  focused = readFocused();
  setLooking(focused);
  blurredAt = focused ? 0 : now;

  if (typeof window === "undefined") return stopPresence;

  const onPointer = (): void => onInput();
  const onKey = (): void => onInput();
  const onWheel = (): void => onInput();
  window.addEventListener("pointerdown", onPointer);
  window.addEventListener("pointermove", onPointer);
  window.addEventListener("keydown", onKey);
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("focus", onFocusChange);
  window.addEventListener("blur", onFocusChange);
  document.addEventListener("visibilitychange", onFocusChange);

  unlisten = () => {
    window.removeEventListener("pointerdown", onPointer);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("focus", onFocusChange);
    window.removeEventListener("blur", onFocusChange);
    document.removeEventListener("visibilitychange", onFocusChange);
  };

  tickAll();
  return stopPresence;
}

function stopPresence(): void {
  if (!attached) return;
  attached = false;
  for (const watch of watches.values()) clearTimer(watch);
  watches.clear();
  otherWindows.clear();
  unlisten?.();
  unlisten = null;
  stopLooking();
}
