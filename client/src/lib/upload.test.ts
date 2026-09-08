/**
 * The upload's arithmetic. Getting the part plan wrong is how a resumed upload
 * sends the wrong bytes to the right URL, and neither end would notice until
 * the file came out corrupt, so the boundaries are pinned here.
 */
import { describe, expect, it } from "vitest";

import { mimeOf, partRanges } from "./upload";
import { absoluteUrl } from "./url";

const MB = 1024 * 1024;
const PART = 8 * MB;

describe("partRanges", () => {
  it("sends a small file in one go", () => {
    expect(partRanges(1234, PART)).toEqual([{ number: 1, start: 0, end: 1234 }]);
  });

  it("treats a file exactly the part size as one part", () => {
    expect(partRanges(PART, PART)).toHaveLength(1);
  });

  it("cuts a big one up, and the last part is the remainder", () => {
    const ranges = partRanges(PART * 2 + 100, PART);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual({ number: 1, start: 0, end: PART });
    expect(ranges[2]).toEqual({ number: 3, start: PART * 2, end: PART * 2 + 100 });
  });

  it("covers every byte exactly once, at 400 MB", () => {
    const size = 400 * MB;
    const ranges = partRanges(size, PART);
    expect(ranges).toHaveLength(50);
    expect(ranges[0]?.start).toBe(0);
    expect(ranges.at(-1)?.end).toBe(size);
    for (let at = 1; at < ranges.length; at += 1) {
      expect(ranges[at]?.start).toBe(ranges[at - 1]?.end);
      expect(ranges[at]?.number).toBe(at + 1);
    }
  });
});

describe("absoluteUrl", () => {
  it("leaves a URL that is already somewhere alone", () => {
    expect(absoluteUrl("http://box.local:8080", "https://s3.example/bucket/key?sig=1")).toBe(
      "https://s3.example/bucket/key?sig=1",
    );
  });

  it("hangs a root-relative one off the server we are talking to", () => {
    expect(absoluteUrl("http://box.local:8080", "/upload/abc/1")).toBe(
      "http://box.local:8080/upload/abc/1",
    );
  });
});

describe("mimeOf", () => {
  it("falls back to the catch-all when the browser has no idea", () => {
    expect(mimeOf(new File(["x"], "save.dat", { type: "" }))).toBe("application/octet-stream");
    expect(mimeOf(new File(["x"], "a.png", { type: "image/png" }))).toBe("image/png");
  });
});
