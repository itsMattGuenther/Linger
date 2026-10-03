/**
 * Presence across the Buddy list client's windows
 * (docs/design/architecture.md): the person is at Linger when any of its
 * windows has focus, and typing in any window counts as being here. Today's
 * client never reports another window, so the rules it relies on are
 * unchanged (`watchPresence.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame } from "../generated/ClientFrame";

const outbox: ClientFrame[] = [];
let ownFocused = false;

vi.mock("./gateway", () => ({
  send: async (_server: string, frame: ClientFrame): Promise<boolean> => {
    outbox.push(frame);
    return true;
  },
}));
vi.mock("./looking", () => ({
  readFocused: () => ownFocused,
  setLooking: () => undefined,
  stopLooking: () => undefined,
}));

const { forgetWindow, onBack, reportWindow, setPresenceLive, setPresenceRoom, startPresence } = await import("./watchPresence");
const { IDLE_AFTER_MS, LEAVE_AFTER_MS } = await import("./presence");

const HOME = "https://home.example";
const ROOM = "room-general";

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const rooms = () => outbox.filter((frame) => frame.op === "room.focus").map((frame) => (frame.op === "room.focus" ? frame.d.room_id : null));

describe("presence with a chat window", () => {
  let stop: () => void = () => undefined;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T22:00:00Z"));
    ownFocused = false;
    outbox.length = 0;
    stop = startPresence();
    setPresenceLive(HOME, true);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("stays in the room while the chat window has focus, even long after the list lost it", async () => {
    reportWindow("chat", { focused: true, input: true });
    setPresenceRoom(HOME, ROOM);
    await settle();
    expect(rooms()).toEqual([ROOM]);

    vi.setSystemTime(Date.now() + LEAVE_AFTER_MS + 60_000);
    reportWindow("chat", { focused: true, input: true });
    await settle();
    expect(rooms()).toEqual([ROOM]);
  });

  it("leaves the room once no window has focus for long enough", async () => {
    reportWindow("chat", { focused: true, input: true });
    setPresenceRoom(HOME, ROOM);
    await settle();

    reportWindow("chat", { focused: false });
    vi.setSystemTime(Date.now() + LEAVE_AFTER_MS + 1_000);
    reportWindow("chat", { focused: false });
    await settle();
    expect(rooms()).toEqual([ROOM, null]);
  });

  it("stops counting a window that closed", async () => {
    reportWindow("chat", { focused: true, input: true });
    setPresenceRoom(HOME, ROOM);
    await settle();

    forgetWindow("chat");
    vi.setSystemTime(Date.now() + LEAVE_AFTER_MS + 1_000);
    reportWindow("other", { focused: false });
    await settle();
    expect(rooms()).toEqual([ROOM, null]);
  });

  it("counts typing in the chat window as being here", async () => {
    reportWindow("chat", { focused: true, input: true });
    setPresenceRoom(HOME, ROOM);
    await settle();
    for (let minute = 0; minute < 15; minute += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      reportWindow("chat", { focused: true, input: true });
    }
    await settle();
    expect(outbox.some((frame) => frame.op === "presence.update" && frame.d.state === "idle")).toBe(false);
  });

  // Back at Linger after as long away as going idle takes (#392): the list
  // asks then whether somebody who's still away is back.
  it("says somebody's back on the first input or focus after a long quiet, and not on any other", async () => {
    let back = 0;
    const stopListening = onBack(() => {
      back += 1;
    });
    reportWindow("chat", { focused: true, input: true });
    expect(back).toBe(0);
    vi.setSystemTime(Date.now() + IDLE_AFTER_MS - 1_000);
    reportWindow("chat", { focused: true, input: true });
    expect(back).toBe(0);

    // A long quiet, then input in a window.
    vi.setSystemTime(Date.now() + IDLE_AFTER_MS);
    reportWindow("chat", { focused: true, input: true });
    expect(back).toBe(1);
    reportWindow("chat", { focused: true, input: true });
    expect(back).toBe(1);

    // A long quiet with no window in focus, then one takes it.
    reportWindow("chat", { focused: false });
    vi.setSystemTime(Date.now() + IDLE_AFTER_MS + 1_000);
    reportWindow("chat", { focused: true });
    expect(back).toBe(2);

    stopListening();
    vi.setSystemTime(Date.now() + IDLE_AFTER_MS + 1_000);
    reportWindow("chat", { focused: true, input: true });
    expect(back).toBe(2);
    await settle();
  });
});

