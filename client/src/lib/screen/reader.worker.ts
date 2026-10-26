/**
 * A shared screen's frames, read in a worker (#360, T-1907). WebKitGTK has
 * the track processor, which hands over a track's frames as they come, only
 * in a worker and only once the desktop shell turns it on
 * (`src-tauri/src/screen_capture.rs`); WebKit can hand a track to a worker,
 * which Chromium can't. So on Linux the page sends a copy of the screen's
 * track here, and each frame goes back to the page, which encodes and sends
 * it as it does Chromium's (`share.ts`). A worker keeps reading with the
 * window behind others, where a video in the page stops being played.
 *
 * The page says `probe` (is there a track processor here?), `read` with a
 * track, `took` when it has dealt with a frame, and `stop`. This says
 * `probe` with the answer, `frame` with each frame, and `ended` when the
 * track ends.
 */

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
type TrackProcessorClass = new (init: { track: MediaStreamTrack }) => TrackProcessor;

function trackProcessor(): TrackProcessorClass | null {
  const found: unknown = Reflect.get(globalThis, "MediaStreamTrackProcessor");
  return typeof found === "function" ? (found as TrackProcessorClass) : null;
}

/**
 * Frames sent that the page hasn't dealt with yet. Past two the page is
 * behind, and a frame is dropped here rather than queued there: a screen is
 * only ever wanted as it is now.
 */
const MOST_UNTAKEN = 2;
let untaken = 0;
let reading: { track: MediaStreamTrack; reader: ReadableStreamDefaultReader<VideoFrame> } | null = null;

function isTrack(value: unknown): value is MediaStreamTrack {
  return typeof value === "object" && value !== null && "kind" in value && "stop" in value && typeof value.stop === "function";
}

function stop(): void {
  const was = reading;
  reading = null;
  if (!was) return;
  void was.reader.cancel().catch(() => undefined);
  was.track.stop();
}

async function read(track: MediaStreamTrack): Promise<void> {
  stop();
  const Processor = trackProcessor();
  if (!Processor) {
    track.stop();
    self.postMessage({ op: "ended" });
    return;
  }
  const reader = new Processor({ track }).readable.getReader();
  reading = { track, reader };
  untaken = 0;
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done || !value) break;
    if (reading?.reader !== reader || untaken >= MOST_UNTAKEN) {
      value.close();
      continue;
    }
    try {
      self.postMessage({ op: "frame", frame: value }, { transfer: [value] });
      untaken += 1;
    } catch {
      // A frame this engine can't hand back: the page stops waiting for any.
      value.close();
      break;
    }
  }
  if (reading?.reader === reader) {
    reading = null;
    self.postMessage({ op: "ended" });
  }
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const said = event.data;
  if (typeof said !== "object" || said === null || !("op" in said)) return;
  if (said.op === "probe") self.postMessage({ op: "probe", reads: trackProcessor() !== null });
  else if (said.op === "took") untaken = Math.max(0, untaken - 1);
  else if (said.op === "stop") stop();
  else if (said.op === "read" && "track" in said && isTrack(said.track)) void read(said.track);
});

// A module: it's started as one (`reader.ts`).
export {};
