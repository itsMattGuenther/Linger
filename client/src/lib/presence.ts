/**
 * Being in a room, and the two clocks that take you out of it.
 *
 * SPEC §4.1: focusing the app on a room means you are in the room. Other
 * people see this. Backgrounding the app, or sitting still for 90 seconds,
 * takes you out. SPEC §4.3: no input for ten minutes is `idle`.
 *
 * Pure, and takes the clock as arguments, so the 90-second and ten-minute
 * edges can be tested without waiting for either. The driver that reads the
 * window and sends the frames is `watchPresence.ts`.
 *
 * A phone app put away (#830, SPEC §4.15) is idle and in no room at once,
 * with no clock: the phone's own notifications start only when its owner
 * isn't using Linger anywhere (PROTOCOL §5), and a phone in a pocket isn't.
 *
 * `away` is a deliberate state a person chooses, not a clock running out, so
 * it comes in from outside as `wantAway` and outranks everything here: while
 * it is set the two clocks stop mattering, because somebody who said they are
 * away does not stop being away by sitting still.
 */
import type { ClientFrame } from "../generated/ClientFrame";
import type { PresenceState } from "../generated/PresenceState";
import type { RoomId } from "../generated/RoomId";

/** Backgrounding or sitting still for this long takes you out of the room. */
export const LEAVE_AFTER_MS = 90_000;

/** No input for this long is `idle` (SPEC §4.3). */
export const IDLE_AFTER_MS = 10 * 60_000;

/** Everything `decide` needs, and nothing it would have to go and fetch. */
export interface PresenceClock {
  /** The window has the user's attention right now. */
  focused: boolean;
  /**
   * The phone app is in the background (#830): idle, in no room, now. Never
   * true on a computer, whose minimised window keeps the ten-minute clock.
   */
  putAway: boolean;
  /** Last pointer, key, wheel, or focus. Not blur — that is `blurredAt`. */
  lastInputAt: number;
  /** When the window last lost focus. Ignored while `focused` is true. */
  blurredAt: number;
  /** The room on screen, if any. */
  roomId: RoomId | null;
  /** The last `room.focus` we actually got onto the wire. */
  sentRoomId: RoomId | null;
  /** The last presence state we sent, or that `ready` gave us. */
  sentState: PresenceState;
  /**
   * The away message the person asked to wear, or null for "not away"
   * (SPEC §4.6). Set by the editor, not by any clock in this file.
   */
  wantAway: string | null;
  /** The away message we last got onto the wire, so a reword is noticed. */
  sentAwayMessage: string | null;
}

export type PresenceAction =
  | { kind: "focus"; roomId: RoomId | null }
  | { kind: "state"; state: "idle" | "around" }
  | { kind: "away"; message: string | null };

/**
 * Whether the 90-second clocks still say this person is here.
 *
 * Two clocks, because the spec names two ways of leaving: sitting still, and
 * putting the app in the background. Either one expiring is enough.
 */
export function stillHere(clock: PresenceClock, now: number): boolean {
  if (clock.putAway) return false;
  if (now - clock.lastInputAt >= LEAVE_AFTER_MS) return false;
  if (!clock.focused && now - clock.blurredAt >= LEAVE_AFTER_MS) return false;
  return true;
}

/** The room we should be in, or `null` for not in one. */
export function wantedRoom(clock: PresenceClock, now: number): RoomId | null {
  if (clock.roomId === null || !stillHere(clock, now)) return null;
  return clock.roomId;
}

/**
 * The next frame to send, or `null` if the wire already matches.
 *
 * Room membership is `room.focus`. Idle is `presence.update`. The server
 * sets `in_room` / `around` from the former, so this never sends those as a
 * state of their own — doing so would either no-op or fight the room.
 *
 * **Leave the room, then go away.** The server sets `around` on any
 * `room.focus` with `null`, so sending the leave *after* the away frame would
 * wipe the away state a moment after setting it. Same order idle uses, and for
 * the same reason. One action per call: the driver loops until this returns
 * null, so the two frames go out in order rather than racing.
 */
export function decide(clock: PresenceClock, now: number): PresenceAction | null {
  if (clock.wantAway !== null) {
    // Out of the room first, or the leave undoes what comes next.
    if (clock.sentRoomId !== null) return { kind: "focus", roomId: null };
    if (clock.sentState !== "away" || clock.sentAwayMessage !== clock.wantAway) {
      return { kind: "away", message: clock.wantAway };
    }
    // Away is sticky. Sitting still does not make somebody more away, and the
    // ten-minute clock must not quietly downgrade them to `idle`.
    return null;
  }

  // Back from away. Say so once; the clocks below take over from the next pass.
  if (clock.sentState === "away") return { kind: "state", state: "around" };

  const want = wantedRoom(clock, now);
  if (want !== clock.sentRoomId) return { kind: "focus", roomId: want };

  const idle = clock.putAway || now - clock.lastInputAt >= IDLE_AFTER_MS;
  if (idle && clock.sentState !== "idle") return { kind: "state", state: "idle" };
  if (!idle && clock.sentState === "idle") return { kind: "state", state: "around" };
  return null;
}

/**
 * When `decide` will next have something new to say, if nobody touches the
 * window. `null` means it is waiting on input, not on the clock.
 */
export function nextCheckAt(clock: PresenceClock, now: number): number | null {
  // Nothing to wait for while away: no clock changes the answer, only the
  // person coming back does, and that arrives as an event.
  if (clock.wantAway !== null) return null;
  const times: number[] = [];
  const leaveByInput = clock.lastInputAt + LEAVE_AFTER_MS;
  if (leaveByInput > now) times.push(leaveByInput);
  if (!clock.focused) {
    const leaveByBlur = clock.blurredAt + LEAVE_AFTER_MS;
    if (leaveByBlur > now) times.push(leaveByBlur);
  }
  const idleAt = clock.lastInputAt + IDLE_AFTER_MS;
  if (idleAt > now) times.push(idleAt);
  if (times.length === 0) return null;
  return Math.min(...times);
}

export function frameFor(action: PresenceAction): ClientFrame {
  if (action.kind === "focus") {
    return { op: "room.focus", d: { room_id: action.roomId } };
  }
  if (action.kind === "away") {
    // The message rides along so everyone connected sees it now. The copy that
    // outlives the session is saved separately, on the status (SPEC §4.6).
    return {
      op: "presence.update",
      d: { state: "away", away_message: action.message },
    };
  }
  return {
    op: "presence.update",
    d: { state: action.state, away_message: null },
  };
}
