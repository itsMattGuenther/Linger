/**
 * The upload's arithmetic. Getting the part plan wrong is how a resumed upload
 * sends the wrong bytes to the right URL, and neither end would notice until
 * the file came out corrupt, so the boundaries are pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "../generated/Attachment";
import type { UploadSlot } from "../generated/UploadSlot";
import { ApiError, type AuthedApi } from "./api";
import { mimeOf, partRanges, uploadFile } from "./upload";
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

describe("uploadFile", () => {
  const SLOT: UploadSlot = {
    upload_id: "u-1",
    attachment_id: "u-1",
    method: "PUT",
    url: "/upload/u-1/1?exp=1&sig=ab",
    headers: {},
    part_size_bytes: PART,
    parts: null,
  };
  const FINISHED: Attachment = {
    id: "u-1", filename: "clip.mp4", mime: "video/mp4", size_bytes: 100, url: "/objects/u-1",
    width: null, height: null, duration_ms: null, blurhash: null, poster_url: null,
    starred_at: null, uploader_id: "me", created_at: 0,
  };

  /** The three calls an upload makes of the server, and nothing else. */
  function server(complete: () => Promise<Attachment> = () => Promise.resolve(FINISHED)) {
    return {
      baseUrl: "http://127.0.0.1:8420",
      createUpload: vi.fn(() => Promise.resolve(SLOT)),
      completeUpload: vi.fn(complete),
      cancelUpload: vi.fn(() => Promise.resolve()),
    };
  }
  const clip = () => new File(["x".repeat(100)], "clip.mp4", { type: "video/mp4" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A file taken out of the message box while it's still going up (#503):
  // the bytes stop, and the server hears it's not wanted, so its space is
  // free for everybody straight away rather than after an hour.
  it("stops sending and gives the slot back when it's stopped", async () => {
    const fake = server();
    // The store never answers: the bytes are still on their way.
    const put = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", put);
    const stop = new AbortController();

    const going = uploadFile(fake as unknown as AuthedApi, clip(), { signal: stop.signal });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    stop.abort();

    await expect(going).rejects.toThrow();
    expect(put).toHaveBeenCalledTimes(1);
    expect(fake.completeUpload).not.toHaveBeenCalled();
    expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
  });

  it("throws away a file stopped just as the server finished it", async () => {
    const stop = new AbortController();
    const fake = server(() => {
      stop.abort();
      return Promise.resolve(FINISHED);
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200, headers: { etag: '"e1"' } }))));

    await expect(uploadFile(fake as unknown as AuthedApi, clip(), { signal: stop.signal })).rejects.toThrow();
    expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
  });

  it("gives the slot back when the server refuses the file", async () => {
    const fake = server(() => Promise.reject(new ApiError(415, { code: "UNSUPPORTED_MEDIA", message: "Not that.", retry_after_ms: null })));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(uploadFile(fake as unknown as AuthedApi, clip())).rejects.toThrow("Not that.");
    expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
  });

  it("keeps a finished upload nobody stopped", async () => {
    const fake = server();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(uploadFile(fake as unknown as AuthedApi, clip(), { signal: new AbortController().signal })).resolves.toEqual(FINISHED);
    expect(fake.cancelUpload).not.toHaveBeenCalled();
  });
});
