import { describe, expect, it } from "vitest";
import { type EventSource, followMediaKeys, type MediaSessionLike } from "./mediaKeys";

/**
 * A page and its media session: the handlers the page gave the session, as
 * the desktop would call them, and players that play and pause as a real
 * `<audio>` does, events and all.
 */
function desktop() {
  const handlers = new Map<string, () => void>();
  const session: MediaSessionLike = {
    playbackState: "none",
    setActionHandler: (action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
  };
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const page: EventSource = {
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => void listeners.delete(type),
  };
  const player = () => {
    const media = {
      paused: true,
      starts: 0,
      play() {
        if (!media.paused) return;
        media.paused = false;
        media.starts += 1;
        listeners.get("play")?.({ target: media });
      },
      pause() {
        if (media.paused) return;
        media.paused = true;
        listeners.get("pause")?.({ target: media });
      },
      end() {
        media.paused = true;
        listeners.get("ended")?.({ target: media });
      },
    };
    return media;
  };
  /** The desktop presses one: a media key, or a program like a dictation tool. */
  const press = (action: "play" | "pause" | "stop") => handlers.get(action)?.();
  return { session, page, handlers, listeners, player, press };
}

describe("the desktop's play and pause (#353)", () => {
  it("never starts a song you paused: a dictation tool's pause, then play, leaves it quiet", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const song = d.player();
    song.play();
    song.pause();
    d.press("pause");
    d.press("play");
    expect(song.paused).toBe(true);
    expect(song.starts).toBe(1);
  });

  it("never starts a song nobody played", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const song = d.player();
    d.press("play");
    expect(song.starts).toBe(0);
  });

  it("pauses what's playing, and resumes it when the desktop says play", async () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const song = d.player();
    song.play();
    d.press("pause");
    expect(song.paused).toBe(true);
    d.press("play");
    await Promise.resolve();
    expect(song.paused).toBe(false);
    expect(song.starts).toBe(2);
    // Once: a second play from outside resumes nothing more.
    song.pause();
    d.press("play");
    expect(song.paused).toBe(true);
  });

  it("forgets the desktop's pause once you play something yourself", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const first = d.player();
    const second = d.player();
    first.play();
    d.press("pause");
    // You play another file, then pause it: a play from outside starts neither.
    second.play();
    second.pause();
    d.press("play");
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(true);
  });

  it("stop pauses what's playing and nothing comes back after it", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const song = d.player();
    song.play();
    d.press("stop");
    d.press("play");
    expect(song.paused).toBe(true);
  });

  it("tells the desktop whether it's playing, so the desktop needn't guess", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    const song = d.player();
    expect(d.session.playbackState).toBe("none");
    song.play();
    expect(d.session.playbackState).toBe("playing");
    song.pause();
    expect(d.session.playbackState).toBe("paused");
    song.play();
    song.end();
    expect(d.session.playbackState).toBe("paused");
  });

  it("ignores events from anything that isn't a player", () => {
    const d = desktop();
    followMediaKeys(d.session, d.page);
    d.listeners.get("play")?.({ target: { nodeName: "DIV" } });
    expect(d.session.playbackState).toBe("none");
  });

  it("changes nothing where the engine has no Media Session API, and lets go when stopped", () => {
    const d = desktop();
    expect(() => followMediaKeys(undefined, d.page)()).not.toThrow();
    expect(d.listeners.size).toBe(0);
    const stop = followMediaKeys(d.session, d.page);
    expect([...d.handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);
    stop();
    expect(d.handlers.size).toBe(0);
    expect(d.listeners.size).toBe(0);
  });
});
