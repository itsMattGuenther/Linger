import { describe, expect, it } from "vitest";
import { FRAME_HEADER_BYTES, packFrame, readFrame } from "./frames";
import { closingOf, readSaid, retryAfter } from "./socket";
import { encoderConfig, fitWithin, SCREEN_SPEEDS } from "./presets";

describe("a screen frame (PROTOCOL §8)", () => {
  it("is a 12-byte header and the picture, the same both ways", () => {
    const picture = new Uint8Array([9, 8, 7]);
    const packed = packFrame("avc1", true, 1_234_567, picture);
    expect(packed.byteLength).toBe(FRAME_HEADER_BYTES + 3);
    expect([...new Uint8Array(packed, 0, 4)]).toEqual([1, 2, 1, 0]);
    const read = readFrame(packed);
    expect(read).not.toBeNull();
    expect(read?.codec).toBe("avc1");
    expect(read?.key).toBe(true);
    expect(read?.micros).toBe(1_234_567);
    expect([...(read?.data ?? [])]).toEqual([9, 8, 7]);
    expect(readFrame(packFrame("vp8", false, 0, picture))?.codec).toBe("vp8");
  });

  it("reads nothing from a header alone, another version, or a format it doesn't know", () => {
    expect(readFrame(new ArrayBuffer(FRAME_HEADER_BYTES))).toBeNull();
    const other = packFrame("vp8", false, 0, new Uint8Array([1]));
    new DataView(other).setUint8(0, 2);
    expect(readFrame(other)).toBeNull();
    const unknown = packFrame("vp8", false, 0, new Uint8Array([1]));
    new DataView(unknown).setUint8(1, 9);
    expect(readFrame(unknown)).toBeNull();
  });
});

describe("a share's size and settings", () => {
  it("fits 1920×1080 with its shape kept, never bigger, in even numbers", () => {
    expect(fitWithin(3840, 2160, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(2560, 1440, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    // An ultrawide keeps its width to 1920 and is shorter.
    expect(fitWithin(3440, 1440, 1920, 1080)).toEqual({ width: 1920, height: 802 });
    // A small window stays its own size, made even.
    expect(fitWithin(801, 601, 1920, 1080)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 0, 1920, 1080)).toEqual({ width: 2, height: 2 });
  });

  it("asks less at 30 frames a second than at 60, and H.264 in Annex B", () => {
    expect(SCREEN_SPEEDS[30].bitrate).toBeLessThan(SCREEN_SPEEDS[60].bitrate);
    // The server's ceiling is 10 Mbit/s; both stay well under it.
    expect(SCREEN_SPEEDS[60].bitrate).toBeLessThanOrEqual(6_000_000);
    const avc = encoderConfig("avc1", SCREEN_SPEEDS[60], 1920, 1080, true);
    expect(avc.avc).toEqual({ format: "annexb" });
    expect(avc.hardwareAcceleration).toBe("prefer-hardware");
    expect(avc.framerate).toBe(60);
    const vp8 = encoderConfig("vp8", SCREEN_SPEEDS[30], 1280, 720, false);
    expect(vp8.avc).toBeUndefined();
    expect(vp8.latencyMode).toBe("realtime");
  });
});

describe("the screen socket's words", () => {
  it("reads the server's closing codes", () => {
    expect([4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 1006].map(closingOf)).toEqual([
      "not-signed-in",
      "not-in-voice",
      "room-full",
      "nothing-to-watch",
      "bad-hello",
      "replaced",
      "ended",
      "off",
      "busy",
      "dropped",
    ]);
  });

  it("reads only JSON with an op, and backs off up to 8 s", () => {
    expect(readSaid('{"op":"want","codecs":["vp8"]}')).toEqual({ op: "want", codecs: ["vp8"] });
    expect(readSaid("not json")).toBeNull();
    expect(readSaid('{"codecs":[]}')).toBeNull();
    expect(readSaid(new ArrayBuffer(2))).toBeNull();
    expect([0, 1, 2, 3, 9].map(retryAfter)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });
});
