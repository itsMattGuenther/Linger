/**
 * The desktop's play and pause, for the sound and video shared in Linger
 * (#353).
 *
 * The web engine tells the desktop about a page's media, so media keys and
 * other programs can control it: on Linux WebKitGTK shows it as an MPRIS
 * player, and on Windows WebView2 puts it in the system's media controls. By
 * default a "Play" from outside plays whatever the page last had, and so a
 * song somebody posted, and that you paused, started playing on its own when
 * a dictation tool paused "all media" to listen and then resumed it (voxtype;
 * reproduced in WebKitGTK 2.52 with MPRIS Pause then Play).
 *
 * So the page answers those itself, through the Media Session API. "Pause"
 * pauses what's playing and remembers that it did; "Play" resumes only that,
 * and never starts anything you didn't. A song you pause, or never started,
 * stays quiet whatever the desktop asks. Media keys still pause and resume
 * what's playing. The page also says whether it's playing, so the desktop
 * doesn't have to guess.
 */

/** The part of the Media Session API this uses, so tests can hand it a fake. */
export interface MediaSessionLike {
  playbackState: "none" | "paused" | "playing";
  setActionHandler(action: "play" | "pause" | "stop", handler: (() => void) | null): void;
}

/** A played thing: an `<audio>` or `<video>`. */
interface Playable {
  paused: boolean;
  pause(): void;
  play(): Promise<void> | void;
}

/** Where media events come from: the page, listened to in the capture phase, since they don't bubble. */
export interface EventSource {
  addEventListener(type: string, listener: (event: { target: unknown }) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: { target: unknown }) => void, capture: boolean): void;
}

function playable(target: unknown): target is Playable {
  return (
    typeof target === "object" &&
    target !== null &&
    "paused" in target &&
    typeof Reflect.get(target, "pause") === "function" &&
    typeof Reflect.get(target, "play") === "function"
  );
}

/**
 * Answer the desktop's play, pause and stop for this page. Answers how to
 * stop answering. Where the engine has no Media Session API, nothing changes.
 */
export function followMediaKeys(session: MediaSessionLike | undefined, page: EventSource): () => void {
  if (!session) return () => undefined;
  // What played last, and what the desktop paused (only that may be resumed).
  let current: Playable | null = null;
  let pausedFromOutside: Playable | null = null;

  const onPlay = ({ target }: { target: unknown }) => {
    if (!playable(target)) return;
    current = target;
    // Played in the app: an old pause from outside no longer means anything.
    pausedFromOutside = null;
    session.playbackState = "playing";
  };
  const onStop = ({ target }: { target: unknown }) => {
    if (target === current) session.playbackState = "paused";
  };

  session.setActionHandler("pause", () => {
    if (current === null || current.paused) return;
    pausedFromOutside = current;
    current.pause();
  });
  session.setActionHandler("play", () => {
    const resume = pausedFromOutside;
    pausedFromOutside = null;
    if (resume?.paused) void Promise.resolve(resume.play()).catch(() => undefined);
  });
  session.setActionHandler("stop", () => {
    pausedFromOutside = null;
    current?.pause();
  });
  page.addEventListener("play", onPlay, true);
  page.addEventListener("pause", onStop, true);
  page.addEventListener("ended", onStop, true);

  return () => {
    page.removeEventListener("play", onPlay, true);
    page.removeEventListener("pause", onStop, true);
    page.removeEventListener("ended", onStop, true);
    for (const action of ["play", "pause", "stop"] as const) session.setActionHandler(action, null);
  };
}
