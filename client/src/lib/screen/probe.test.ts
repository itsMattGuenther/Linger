import { afterEach, describe, expect, it, vi } from "vitest";
import { sharesFromHere } from "./probe";

/** An engine with the picker and WebCodecs, under a user agent. */
function engine(userAgent: string): void {
  vi.stubGlobal("navigator", { userAgent, mediaDevices: { getDisplayMedia: () => undefined } });
  vi.stubGlobal("VideoEncoder", function VideoEncoder() {});
  vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
  vi.stubGlobal("EncodedVideoChunk", function EncodedVideoChunk() {});
}

afterEach(() => vi.unstubAllGlobals());

describe("where Share is offered (SPEC §4.20, #360)", () => {
  it("is the Windows app, for now", () => {
    engine("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0");
    expect(sharesFromHere()).toBe(true);
  });

  it("isn't Linux or a Mac yet, where the picker needs the shell first (T-1907)", () => {
    engine("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    expect(sharesFromHere()).toBe(false);
    engine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect(sharesFromHere()).toBe(false);
  });

  it("isn't an engine without the picker or WebCodecs, even on Windows", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0", mediaDevices: {} });
    expect(sharesFromHere()).toBe(false);
  });
});
