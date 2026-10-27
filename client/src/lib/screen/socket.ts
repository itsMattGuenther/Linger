import type { ScreenHello } from "../../generated/ScreenHello";

/** Where the screen socket is, under the server's address (PROTOCOL §8). */
const SCREEN_PATH = "/api/v1/screen";

/**
 * Open a screen socket to `baseUrl`, the server this window is signed in to,
 * and say hello on it (#360). It is the one WebSocket the page opens itself:
 * the gateway is the desktop core's, and screens travel apart from it so a
 * frame never waits behind a message, or a message behind a frame.
 */
export function openScreenSocket(baseUrl: string, hello: ScreenHello): WebSocket {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${SCREEN_PATH}`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
  return socket;
}

/**
 * How long a screen socket may hear nothing, not even the server's `alive`
 * (every `SCREEN_ALIVE_MS`, 5 s), before its line counts as dropped and it
 * connects again: three of them. A still screen sends nothing and a watcher
 * asks nothing, so a line that died without closing looked, for minutes,
 * like a still slide. Tests shorten it.
 */
export const screenSilence = { ms: 15_000 };

/**
 * Call `silent`, once, if `socket` hears nothing for `screenSilence.ms`
 * from when it opens or last heard something. Stops by itself when the
 * socket closes; answers how to stop it sooner.
 */
export function onSilence(socket: WebSocket, silent: () => void): () => void {
  let heard = performance.now();
  const hear = () => {
    heard = performance.now();
  };
  const timer = window.setInterval(
    () => {
      if (performance.now() - heard < screenSilence.ms) return;
      stop();
      silent();
    },
    Math.min(1_000, screenSilence.ms / 3),
  );
  const stop = () => {
    window.clearInterval(timer);
    socket.removeEventListener("message", hear);
    socket.removeEventListener("open", hear);
    socket.removeEventListener("close", stop);
  };
  socket.addEventListener("message", hear);
  socket.addEventListener("open", hear);
  socket.addEventListener("close", stop);
  return stop;
}

/** What closing codes the server uses mean, for the person (PROTOCOL §8). */
export type ScreenClosing = "not-signed-in" | "not-in-voice" | "room-full" | "nothing-to-watch" | "bad-hello" | "replaced" | "ended" | "off" | "busy" | "dropped";

export function closingOf(code: number): ScreenClosing {
  switch (code) {
    case 4001:
      return "not-signed-in";
    case 4002:
      return "not-in-voice";
    case 4003:
      return "room-full";
    case 4004:
      return "nothing-to-watch";
    case 4005:
      return "bad-hello";
    case 4006:
      return "replaced";
    case 4007:
      return "ended";
    case 4008:
      return "off";
    case 4009:
      return "busy";
    default:
      return "dropped";
  }
}

/** A text message off a screen socket, as JSON with an `op`, or null. */
export function readSaid(data: unknown): { op: string; [key: string]: unknown } | null {
  if (typeof data !== "string") return null;
  try {
    const said: unknown = JSON.parse(data);
    if (said === null || typeof said !== "object" || !("op" in said) || typeof said.op !== "string") return null;
    return { ...said, op: said.op };
  } catch {
    return null;
  }
}

/** How long to wait before the `attempt`th try at a dropped socket: 1, 2, 4, 8 s. */
export function retryAfter(attempt: number): number {
  return 1_000 * 2 ** Math.min(3, Math.max(0, attempt));
}

/** How many times a dropped socket is tried again before the app gives up. */
export const RETRIES = 5;
