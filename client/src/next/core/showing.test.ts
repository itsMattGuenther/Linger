import { describe, expect, it } from "vitest";
import { blur, close, focus, NOTHING_SHOWN, presenceRoom, show, viewing } from "./showing";

const HOME = "https://home.example";
const WORK = "https://work.example";
const SIGNED_IN = new Set([HOME, WORK]);

describe("the room you're in, with several windows", () => {
  it("is nowhere until a window shows a conversation", () => {
    expect(presenceRoom(NOTHING_SHOWN, SIGNED_IN)).toBeNull();
    expect(presenceRoom(focus(NOTHING_SHOWN, "chat", 5), SIGNED_IN)).toBeNull();
  });

  it("follows the tab a window shows", () => {
    let showing = show(NOTHING_SHOWN, "chat", HOME, "r-general");
    expect(presenceRoom(showing, SIGNED_IN)).toEqual({ server: HOME, roomId: "r-general" });
    showing = show(showing, "chat", HOME, "r-listening");
    expect(presenceRoom(showing, SIGNED_IN)).toEqual({ server: HOME, roomId: "r-listening" });
  });

  it("with two windows, is the room in the one you were last in, on any server", () => {
    let showing = show(NOTHING_SHOWN, "chat", HOME, "r-general");
    showing = show(showing, "chat-2", WORK, "r-raid");
    showing = focus(showing, "chat", 10);
    showing = focus(showing, "chat-2", 20);
    expect(presenceRoom(showing, SIGNED_IN)).toEqual({ server: WORK, roomId: "r-raid" });
    showing = focus(showing, "chat", 30);
    expect(presenceRoom(showing, SIGNED_IN)).toEqual({ server: HOME, roomId: "r-general" });
  });

  it("a window that closes, or shows nothing, stops counting, and another takes over", () => {
    let showing = show(NOTHING_SHOWN, "chat", HOME, "r-general");
    showing = show(showing, "chat-2", HOME, "r-listening");
    showing = focus(showing, "chat-2", 20);
    expect(presenceRoom(close(showing, "chat-2"), SIGNED_IN)?.roomId).toBe("r-general");
    expect(presenceRoom(show(showing, "chat-2", HOME, null), SIGNED_IN)?.roomId).toBe("r-general");
    expect(presenceRoom(close(close(showing, "chat-2"), "chat"), SIGNED_IN)).toBeNull();
  });

  it("ignores a window on a server you've signed out of", () => {
    const showing = focus(show(show(NOTHING_SHOWN, "chat", HOME, "r-general"), "chat-2", WORK, "r-raid"), "chat-2", 9);
    expect(presenceRoom(showing, new Set([HOME]))).toEqual({ server: HOME, roomId: "r-general" });
  });

  it("remembers focus that arrives before the room does", () => {
    let showing = focus(NOTHING_SHOWN, "chat-2", 50);
    showing = show(showing, "chat", HOME, "r-general");
    showing = show(showing, "chat-2", HOME, "r-listening");
    expect(presenceRoom(showing, SIGNED_IN)?.roomId).toBe("r-listening");
  });

  it("is looking at a conversation only while its window has focus", () => {
    let showing = show(NOTHING_SHOWN, "chat", HOME, "r-general");
    // Shown but never focused: you haven't looked at it.
    expect(viewing(showing, SIGNED_IN)).toBeNull();
    showing = focus(showing, "chat", 10);
    expect(viewing(showing, SIGNED_IN)).toEqual({ server: HOME, roomId: "r-general" });
    showing = show(showing, "chat", HOME, "r-listening");
    expect(viewing(showing, SIGNED_IN)).toEqual({ server: HOME, roomId: "r-listening" });
    // Away to the list, or to another app: looking at nothing, but still in the room.
    showing = blur(showing, "chat");
    expect(viewing(showing, SIGNED_IN)).toBeNull();
    expect(presenceRoom(showing, SIGNED_IN)?.roomId).toBe("r-listening");
    // Another window gets focus.
    showing = focus(show(showing, "chat-2", WORK, "r-raid"), "chat-2", 20);
    expect(viewing(showing, SIGNED_IN)).toEqual({ server: WORK, roomId: "r-raid" });
    expect(viewing(showing, new Set([HOME]))).toBeNull();
    expect(viewing(close(showing, "chat-2"), SIGNED_IN)).toBeNull();
  });
});
