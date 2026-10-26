import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The worker that reads a screen on Linux (#360, T-1907) runs in no test
// browser: only WebKitGTK with the shell's switch on has a track processor
// in a worker. So it runs here, in a stand-in for a worker's scope, against
// a stand-in track processor that hands over frames when told to.

interface Frame {
  close: () => void;
  closed: boolean;
}

function frame(): Frame {
  const made: Frame = { closed: false, close: () => (made.closed = true) };
  return made;
}

let heard: ((event: { data: unknown }) => void) | null = null;
let said: { data: { op: string; frame?: Frame }; transfer: unknown[] }[] = [];
let push: ((value: Frame) => void) | null = null;
let end: (() => void) | null = null;
let cancelled = false;

function worker(processor: boolean): Promise<unknown> {
  vi.stubGlobal("self", {
    addEventListener: (_kind: string, listener: (event: { data: unknown }) => void) => (heard = listener),
    postMessage: (data: { op: string; frame?: Frame }, options?: { transfer?: unknown[] }) => said.push({ data, transfer: options?.transfer ?? [] }),
  });
  if (processor) {
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readable = new ReadableStream<Frame>({
          start: (controller) => {
            push = (value) => controller.enqueue(value);
            end = () => controller.close();
          },
          cancel: () => {
            cancelled = true;
          },
        });
      },
    );
  }
  return import("./reader.worker");
}

const track = () => ({ kind: "video", stopped: false, stop() { this.stopped = true; } });
const tell = (data: unknown) => heard?.({ data });
const settle = () => new Promise((done) => setTimeout(done, 0));
const frames = () => said.filter((one) => one.data.op === "frame");

beforeEach(() => {
  vi.resetModules();
  heard = null;
  said = [];
  push = null;
  end = null;
  cancelled = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("reading a screen in a worker", () => {
  it("says whether it has a track processor", async () => {
    await worker(true);
    tell({ op: "probe" });
    expect(said.at(-1)?.data).toEqual({ op: "probe", reads: true });
    vi.resetModules();
    vi.unstubAllGlobals();
    await worker(false);
    tell({ op: "probe" });
    expect(said.at(-1)?.data).toEqual({ op: "probe", reads: false });
  });

  it("hands each frame back, handed over rather than copied, and no more than two ahead of the page", async () => {
    await worker(true);
    tell({ op: "read", track: track() });
    await settle();
    const sent = [frame(), frame(), frame()];
    for (const one of sent) push?.(one);
    await settle();
    // Two out, the page hasn't dealt with either: the third is dropped here.
    expect(frames().map((one) => one.data.frame)).toEqual([sent[0], sent[1]]);
    expect(frames()[0]?.transfer).toEqual([sent[0]]);
    expect(sent[2]?.closed).toBe(true);
    tell({ op: "took" });
    const next = frame();
    push?.(next);
    await settle();
    expect(frames().at(-1)?.data.frame).toBe(next);
    expect(next.closed).toBe(false);
  });

  it("says when the screen ends, and stops the track when told to", async () => {
    await worker(true);
    const first = track();
    tell({ op: "read", track: first });
    await settle();
    end?.();
    await settle();
    expect(said.at(-1)?.data).toEqual({ op: "ended" });
    const second = track();
    tell({ op: "read", track: second });
    await settle();
    tell({ op: "stop" });
    await settle();
    expect(second.stopped).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("with no track processor, stops the track and says it ended", async () => {
    await worker(false);
    const given = track();
    tell({ op: "read", track: given });
    await settle();
    expect(given.stopped).toBe(true);
    expect(said.at(-1)?.data).toEqual({ op: "ended" });
  });

  it("ignores what isn't a track", async () => {
    await worker(true);
    tell({ op: "read", track: "a window's name" });
    tell({ op: "read" });
    tell("read");
    await settle();
    expect(said).toEqual([]);
  });
});
