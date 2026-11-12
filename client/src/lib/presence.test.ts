/**
 * The 90-second leave and the ten-minute idle, as arithmetic.
 *
 * These are the edges that look right and are wrong if the clocks are off
 * by a second, so they are written as numbers rather than slept through.
 */
import { describe, expect, it } from "vitest";

import type { PresenceClock } from "./presence";
import {
  decide,
  frameFor,
  IDLE_AFTER_MS,
  LEAVE_AFTER_MS,
  nextCheckAt,
  stillHere,
  wantedRoom,
} from "./presence";

const NOW = 1_700_000_000_000;
const ROOM = "room-garage";
const OTHER = "room-porch";

function clock(extra: Partial<PresenceClock> = {}): PresenceClock {
  return {
    focused: true,
    putAway: false,
    lastInputAt: NOW,
    blurredAt: 0,
    roomId: ROOM,
    sentRoomId: null,
    sentState: "around",
    wantAway: null,
    sentAwayMessage: null,
    ...extra,
  };
}

describe("stillHere", () => {
  it("is true while you are looking and have touched the window recently", () => {
    expect(stillHere(clock(), NOW + 1_000)).toBe(true);
  });

  it("is false after 90s with no input, even if the window is still focused", () => {
    expect(stillHere(clock(), NOW + LEAVE_AFTER_MS)).toBe(false);
  });

  it("gives 90s after backgrounding when you were just here", () => {
    const left = clock({
      focused: false,
      lastInputAt: NOW,
      blurredAt: NOW,
    });
    expect(stillHere(left, NOW + LEAVE_AFTER_MS - 1)).toBe(true);
    expect(stillHere(left, NOW + LEAVE_AFTER_MS)).toBe(false);
  });

  it("does not extend a nearly-expired idle clock just because you alt-tabbed", () => {
    const left = clock({
      focused: false,
      lastInputAt: NOW - 80_000,
      blurredAt: NOW,
    });
    expect(stillHere(left, NOW + 10_000)).toBe(false);
  });

  it("is already false if you had been sitting still before you backgrounded", () => {
    const left = clock({
      focused: false,
      lastInputAt: NOW - LEAVE_AFTER_MS,
      blurredAt: NOW,
    });
    expect(stillHere(left, NOW)).toBe(false);
  });
});

describe("wantedRoom", () => {
  it("is the open room while you are here", () => {
    expect(wantedRoom(clock(), NOW)).toBe(ROOM);
  });

  it("is null with no room open", () => {
    expect(wantedRoom(clock({ roomId: null }), NOW)).toBeNull();
  });

  it("is null once either 90s clock has run out", () => {
    expect(wantedRoom(clock(), NOW + LEAVE_AFTER_MS)).toBeNull();
  });
});

describe("decide", () => {
  it("enters the open room", () => {
    expect(decide(clock(), NOW)).toEqual({ kind: "focus", roomId: ROOM });
  });

  it("does nothing once that room is the one we sent", () => {
    expect(decide(clock({ sentRoomId: ROOM, sentState: "in_room" }), NOW)).toBeNull();
  });

  it("switches rooms in one focus, not a leave then an enter", () => {
    expect(
      decide(clock({ roomId: OTHER, sentRoomId: ROOM, sentState: "in_room" }), NOW),
    ).toEqual({ kind: "focus", roomId: OTHER });
  });

  it("leaves after 90s of no input", () => {
    expect(
      decide(clock({ sentRoomId: ROOM, sentState: "in_room" }), NOW + LEAVE_AFTER_MS),
    ).toEqual({ kind: "focus", roomId: null });
  });

  it("leaves after 90s in the background", () => {
    const left = clock({
      focused: false,
      blurredAt: NOW,
      sentRoomId: ROOM,
      sentState: "in_room",
    });
    expect(decide(left, NOW + LEAVE_AFTER_MS)).toEqual({ kind: "focus", roomId: null });
  });

  it("stays in the room through a brief alt-tab", () => {
    const left = clock({
      focused: false,
      blurredAt: NOW,
      sentRoomId: ROOM,
      sentState: "in_room",
    });
    expect(decide(left, NOW + 10_000)).toBeNull();
  });

  it("goes idle after ten minutes, and only once the room is already left", () => {
    const quiet = clock({
      sentRoomId: null,
      sentState: "around",
      lastInputAt: NOW,
    });
    expect(decide(quiet, NOW + IDLE_AFTER_MS)).toEqual({ kind: "state", state: "idle" });
  });

  it("leaves the room first if both clocks have fired at once", () => {
    expect(
      decide(clock({ sentRoomId: ROOM, sentState: "in_room" }), NOW + IDLE_AFTER_MS),
    ).toEqual({ kind: "focus", roomId: null });
  });

  it("does not send idle twice", () => {
    expect(
      decide(
        clock({ sentRoomId: null, sentState: "idle", lastInputAt: NOW }),
        NOW + IDLE_AFTER_MS,
      ),
    ).toBeNull();
  });

  it("comes back from idle into the room when you are looking at one", () => {
    expect(
      decide(clock({ sentRoomId: null, sentState: "idle" }), NOW),
    ).toEqual({ kind: "focus", roomId: ROOM });
  });

  it("comes back from idle as around when you are not looking at a room", () => {
    expect(
      decide(
        clock({
          roomId: null,
          sentRoomId: null,
          sentState: "idle",
          lastInputAt: NOW,
        }),
        NOW,
      ),
    ).toEqual({ kind: "state", state: "around" });
  });

  it("does not overwrite away", () => {
    // The clocks have nothing to say while somebody is deliberately away.
    // T-402 asserted this by looking at `sentState` alone, back when nothing
    // could set the word; `wantAway` is what holds it now.
    expect(
      decide(clock({ wantAway: "brb", sentState: "away", sentAwayMessage: "brb" }), NOW),
    ).toBeNull();
    expect(
      decide(
        clock({
          wantAway: "brb",
          sentState: "away",
          sentAwayMessage: "brb",
          lastInputAt: NOW - IDLE_AFTER_MS,
        }),
        NOW,
      ),
    ).toBeNull();
  });
});

// #830: a phone in a pocket is nobody using Linger, so its own notifications
// start at once rather than after the ten-minute clock.
describe("a phone put away", () => {
  it("leaves its room, then says idle, with no clock to wait for", () => {
    const away = clock({ putAway: true, focused: false, sentRoomId: ROOM });
    expect(decide(away, NOW)).toEqual({ kind: "focus", roomId: null });
    expect(decide({ ...away, sentRoomId: null }, NOW)).toEqual({ kind: "state", state: "idle" });
    expect(decide({ ...away, sentRoomId: null, sentState: "idle" }, NOW)).toBeNull();
  });

  it("says idle at once when it was in no room", () => {
    expect(decide(clock({ putAway: true, roomId: null }), NOW)).toEqual({ kind: "state", state: "idle" });
  });

  it("comes back into its room, and around, once it's back", () => {
    const back = clock({ sentState: "idle", sentRoomId: null });
    expect(decide(back, NOW)).toEqual({ kind: "focus", roomId: ROOM });
    expect(decide({ ...back, sentRoomId: ROOM }, NOW)).toEqual({ kind: "state", state: "around" });
  });

  it("stays away when its person said they were away", () => {
    expect(decide(clock({ putAway: true, wantAway: "out", sentState: "away", sentAwayMessage: "out", sentRoomId: null }), NOW)).toBeNull();
  });
});

describe("going away and coming back", () => {
  it("leaves the room first, then says away", () => {
    // Both frames, in order. The server sets `around` on any room leave, so
    // the other order would wipe the away state a moment after setting it.
    const inRoom = clock({ wantAway: "back at six", sentRoomId: ROOM, sentState: "in_room" });
    expect(decide(inRoom, NOW)).toEqual({ kind: "focus", roomId: null });

    const left = clock({ wantAway: "back at six", sentRoomId: null, sentState: "around" });
    expect(decide(left, NOW)).toEqual({ kind: "away", message: "back at six" });
  });

  it("says away without a leave when you were not in a room", () => {
    expect(
      decide(clock({ wantAway: "brb", roomId: null, sentRoomId: null }), NOW),
    ).toEqual({ kind: "away", message: "brb" });
  });

  it("says it again when the message is reworded", () => {
    expect(
      decide(
        clock({ wantAway: "back at seven", sentState: "away", sentAwayMessage: "back at six" }),
        NOW,
      ),
    ).toEqual({ kind: "away", message: "back at seven" });
  });

  it("does not repeat itself once the wire matches", () => {
    expect(
      decide(clock({ wantAway: "brb", sentState: "away", sentAwayMessage: "brb" }), NOW),
    ).toBeNull();
  });

  it("goes around when you come back", () => {
    expect(
      decide(clock({ wantAway: null, sentState: "away", sentAwayMessage: "brb" }), NOW),
    ).toEqual({ kind: "state", state: "around" });
  });

  it("rejoins the room on the pass after coming back", () => {
    // Coming back is one frame, then the ordinary clocks take over: this is
    // the state after `around` landed, and the room is next.
    expect(
      decide(clock({ wantAway: null, sentState: "around", sentRoomId: null }), NOW),
    ).toEqual({ kind: "focus", roomId: ROOM });
  });

  it("stays away through the ten-minute idle clock", () => {
    // Sitting still does not make somebody more away, and it must not quietly
    // downgrade them to `idle` either.
    expect(
      decide(
        clock({
          wantAway: "brb",
          sentState: "away",
          sentAwayMessage: "brb",
          lastInputAt: NOW - IDLE_AFTER_MS * 2,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("an away message with no room to leave is one frame, not two", () => {
    // Regression shape for the driver's loop: it calls `decide` until null, so
    // a `focus` action here would be a leave nobody asked for.
    const first = decide(clock({ wantAway: "brb", sentRoomId: null }), NOW);
    expect(first).toEqual({ kind: "away", message: "brb" });
  });

  it("puts the message on the frame so everyone sees it now", () => {
    expect(frameFor({ kind: "away", message: "back at six" })).toEqual({
      op: "presence.update",
      d: { state: "away", away_message: "back at six" },
    });
  });

  it("has no clock to wait on while away", () => {
    expect(nextCheckAt(clock({ wantAway: "brb", sentState: "away" }), NOW)).toBeNull();
  });
});

describe("nextCheckAt", () => {
  it("wakes at the 90s leave while you are in a room", () => {
    expect(nextCheckAt(clock({ sentRoomId: ROOM, sentState: "in_room" }), NOW)).toBe(
      NOW + LEAVE_AFTER_MS,
    );
  });

  it("wakes at the background leave when you had just been here", () => {
    const left = clock({
      focused: false,
      lastInputAt: NOW,
      blurredAt: NOW,
      sentRoomId: ROOM,
      sentState: "in_room",
    });
    expect(nextCheckAt(left, NOW)).toBe(NOW + LEAVE_AFTER_MS);
  });

  it("wakes when the input clock runs out, even if the background clock has longer", () => {
    const left = clock({
      focused: false,
      lastInputAt: NOW - 80_000,
      blurredAt: NOW,
      sentRoomId: ROOM,
      sentState: "in_room",
    });
    expect(nextCheckAt(left, NOW)).toBe(NOW + 10_000);
  });

  it("wakes at ten minutes once you have already left", () => {
    expect(
      nextCheckAt(
        clock({
          roomId: null,
          sentRoomId: null,
          sentState: "around",
          lastInputAt: NOW - LEAVE_AFTER_MS,
        }),
        NOW,
      ),
    ).toBe(NOW - LEAVE_AFTER_MS + IDLE_AFTER_MS);
  });

  it("is null once idle and nothing on the clock is left", () => {
    expect(
      nextCheckAt(
        clock({
          roomId: null,
          sentRoomId: null,
          sentState: "idle",
          lastInputAt: NOW - IDLE_AFTER_MS,
        }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("frameFor", () => {
  it("writes the protocol ops, including a null room", () => {
    expect(frameFor({ kind: "focus", roomId: ROOM })).toEqual({
      op: "room.focus",
      d: { room_id: ROOM },
    });
    expect(frameFor({ kind: "focus", roomId: null })).toEqual({
      op: "room.focus",
      d: { room_id: null },
    });
    expect(frameFor({ kind: "state", state: "idle" })).toEqual({
      op: "presence.update",
      d: { state: "idle", away_message: null },
    });
  });
});
