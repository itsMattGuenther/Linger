import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetProbes, sharesFromHere } from "./probe";

/** An engine with the picker and WebCodecs, under a user agent. */
function engine(userAgent: string): void {
  vi.stubGlobal("navigator", { userAgent, mediaDevices: { getDisplayMedia: () => undefined } });
  vi.stubGlobal("VideoEncoder", function VideoEncoder() {});
  vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
  vi.stubGlobal("EncodedVideoChunk", function EncodedVideoChunk() {});
}

/** A reader worker that says, when asked, whether it can read a screen. */
function workers(reads: boolean): void {
  vi.stubGlobal(
    "Worker",
    class {
      #heard = new Set<(event: { data: unknown }) => void>();
      addEventListener(kind: string, listener: (event: { data: unknown }) => void) {
        if (kind === "message") this.#heard.add(listener);
      }
      removeEventListener(_kind: string, listener: (event: { data: unknown }) => void) {
        this.#heard.delete(listener);
      }
      postMessage(said: { op: string }) {
        if (said.op === "probe") setTimeout(() => this.#heard.forEach((listener) => listener({ data: { op: "probe", reads } })), 0);
      }
      terminate() {}
    },
  );
}

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetProbes();
});

describe("where Share is offered (SPEC §4.20, #360)", () => {
  it("is the Windows app, for now", () => {
    engine("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0");
    expect(sharesFromHere()).toBe(true);
  });

  it("is the Linux app once a worker says it can read the screen (T-1907)", async () => {
    engine(LINUX);
    workers(true);
    // Not until the worker has answered.
    expect(sharesFromHere()).toBe(false);
    await vi.waitFor(() => expect(sharesFromHere()).toBe(true));
  });

  it("isn't the Linux app where no worker can read it: an older WebKitGTK, or no shell", async () => {
    engine(LINUX);
    workers(false);
    expect(sharesFromHere()).toBe(false);
    await new Promise((settle) => setTimeout(settle, 10));
    expect(sharesFromHere()).toBe(false);
    forgetProbes();
    vi.stubGlobal("Worker", undefined);
    expect(sharesFromHere()).toBe(false);
  });

  it("isn't a Mac or an Android phone yet", () => {
    engine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    workers(true);
    expect(sharesFromHere()).toBe(false);
    engine("Mozilla/5.0 (Linux; Android 16; Pixel 11 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36");
    expect(sharesFromHere()).toBe(false);
  });

  it("isn't an engine without the picker or WebCodecs, even on Windows", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0", mediaDevices: {} });
    expect(sharesFromHere()).toBe(false);
  });
});
