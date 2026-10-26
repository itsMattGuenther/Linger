/**
 * The page's side of `reader.worker.ts` (#360, T-1907): starting the worker
 * that reads a shared screen's frames where the engine has a track processor
 * only in workers (Linux's WebKitGTK), and asking it whether it has one.
 */

/** How long a worker gets to say whether it can read a screen. */
const PROBE_MS = 3_000;

/** A new reader worker, or null where workers can't start. */
export function openReader(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./reader.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** Whether `worker` has a track processor to read a screen with. */
export function readsHere(worker: Worker): Promise<boolean> {
  return new Promise((answer) => {
    const timer = setTimeout(() => done(false), PROBE_MS);
    const done = (reads: boolean) => {
      clearTimeout(timer);
      worker.removeEventListener("message", heard);
      worker.removeEventListener("error", failed);
      answer(reads);
    };
    const heard = (event: MessageEvent<unknown>) => {
      const said = event.data;
      if (typeof said === "object" && said !== null && "op" in said && said.op === "probe") done("reads" in said && said.reads === true);
    };
    const failed = () => done(false);
    worker.addEventListener("message", heard);
    worker.addEventListener("error", failed);
    worker.postMessage({ op: "probe" });
  });
}
