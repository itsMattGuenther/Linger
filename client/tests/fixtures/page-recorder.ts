/**
 * The phone's recorder (`app/chat/recorders.ts`) on its own, for a spec to
 * drive in orders the panel can't reach on a phone, such as a start while
 * the last stop still finishes (#920). `window.pageRecorder` starts and stops
 * it, and says how many packets each stop handed back and what it said
 * happened by itself.
 */
import { pageRecorder } from "../../src/next/app/chat/recorders";

const ended: string[] = [];
const recorder = pageRecorder({ level: () => undefined, ended: (why) => ended.push(why) });
const stops: Array<Promise<number>> = [];

Object.assign(window, {
  pageRecorder: {
    /** Starts, and answers "started" or why it didn't. */
    start: () => recorder.start().then(
      () => "started",
      (error: unknown) => String(error),
    ),
    /** Stops without waiting; `stopped(n)` is the nth stop's packet count. */
    stop: () => {
      stops.push(recorder.stop().then((clip) => clip?.packets.length ?? -1));
    },
    stopped: (which: number) => stops[which],
    ended: () => [...ended],
  },
});
