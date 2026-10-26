import { afterEach, describe, expect, it, vi } from "vitest";

// What the Linux app's shell says (`shell.ts`), stood in for.
const shell = vi.hoisted(() => ({ through: false, shares: null as boolean | null }));
vi.mock("./shell", () => ({
  sharesThroughShell: () => shell.through,
  shellShares: () => shell.shares,
  onShellAnswer: () => () => undefined,
}));

const { forgetProbes, sharesFromHere } = await import("./probe");

/** An engine with the picker and WebCodecs, under a user agent. */
function engine(userAgent: string): void {
  vi.stubGlobal("navigator", { userAgent, mediaDevices: { getDisplayMedia: () => undefined } });
  vi.stubGlobal("VideoEncoder", function VideoEncoder() {});
  vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
  vi.stubGlobal("EncodedVideoChunk", function EncodedVideoChunk() {});
}

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetProbes();
  shell.through = false;
  shell.shares = null;
});

describe("where Share is offered (SPEC §4.20, #360)", () => {
  it("is the Windows app, for now", () => {
    engine("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0");
    expect(sharesFromHere()).toBe(true);
  });

  it("is the Linux app once its shell says it can capture the screen (T-1907)", () => {
    engine(LINUX);
    shell.through = true;
    // Not until the shell has answered.
    expect(sharesFromHere()).toBe(false);
    shell.shares = true;
    expect(sharesFromHere()).toBe(true);
  });

  it("isn't the Linux app where the shell can't: no portal, or no GStreamer plugins for it", () => {
    engine(LINUX);
    shell.through = true;
    shell.shares = false;
    expect(sharesFromHere()).toBe(false);
    // Nor Linux in a browser, which has no shell.
    shell.through = false;
    shell.shares = true;
    expect(sharesFromHere()).toBe(false);
  });

  it("isn't a Mac or an Android phone yet", () => {
    engine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect(sharesFromHere()).toBe(false);
    engine("Mozilla/5.0 (Linux; Android 16; Pixel 11 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36");
    expect(sharesFromHere()).toBe(false);
  });

  it("isn't an engine without the picker or WebCodecs, even on Windows", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0", mediaDevices: {} });
    expect(sharesFromHere()).toBe(false);
  });
});
