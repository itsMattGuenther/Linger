/**
 * The upload's arithmetic. Getting the part plan wrong is how a resumed upload
 * sends the wrong bytes to the right URL, and neither end would notice until
 * the file came out corrupt, so the boundaries are pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "../generated/Attachment";
import type { UploadSlot } from "../generated/UploadSlot";
import { ApiError, type AuthedApi } from "./api";
import { mimeOf, partRanges, uploadFile, worthTryingAgain } from "./upload";
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

  // #801: the server was busy with other pictures. It keeps the slot and
  // says when to ask again (PROTOCOL §6), so the file is completed again, not
  // sent again, and the slot isn't given back.
  /** Let the upload's promises run, without moving the clock (`vi.waitFor` would). */
  const flush = async () => {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  };
  const busy = () => new ApiError(429, { code: "RATE_LIMITED", message: "The server is busy with other pictures. Send this one again in a moment.", retry_after_ms: 5_000 });

  it("completes again after the wait the server gives when it's busy with other pictures", async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const fake = server(() => (answers++ < 2 ? Promise.reject(busy()) : Promise.resolve(FINISHED)));
      const put = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
      vi.stubGlobal("fetch", put);
      let waits = 0;

      const going = uploadFile(fake as unknown as AuthedApi, clip(), { onWaiting: () => (waits += 1) });
      await flush();
      expect(fake.completeUpload).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fake.completeUpload, "not before the server's five seconds").toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(fake.completeUpload).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(going).resolves.toEqual(FINISHED);
      expect(fake.completeUpload).toHaveBeenCalledTimes(3);
      expect(waits).toBe(2);
      expect(put, "the bytes went once").toHaveBeenCalledTimes(1);
      expect(fake.createUpload).toHaveBeenCalledTimes(1);
      expect(fake.cancelUpload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a few goes, and the caller hears the server's words", async () => {
    vi.useFakeTimers();
    try {
      const fake = server(() => Promise.reject(busy()));
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));

      const going = uploadFile(fake as unknown as AuthedApi, clip());
      const refused = expect(going).rejects.toThrow("The server is busy with other pictures.");
      await vi.advanceTimersByTimeAsync(60_000);
      await refused;
      expect(fake.completeUpload, "once, then three more goes").toHaveBeenCalledTimes(4);
      expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't start waiting for a file taken out as the server said it's busy", async () => {
    vi.useFakeTimers();
    try {
      const fake = server(() => Promise.reject(busy()));
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));
      const stop = new AbortController();

      const going = uploadFile(fake as unknown as AuthedApi, clip(), { signal: stop.signal, onWaiting: () => stop.abort() });
      await expect(going).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.completeUpload).toHaveBeenCalledTimes(1);
      expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
    } finally {
      vi.useRealTimers();
    }
  });

  // Greptile's catch on #802: the case above stops the file before the wait
  // has a timer to clear or a listener to hear it. This one stops it partway
  // through a wait that's running.
  it("stops waiting for the server when the file is taken out during the wait", async () => {
    vi.useFakeTimers();
    try {
      const fake = server(() => Promise.reject(busy()));
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));
      const stop = new AbortController();
      let waits = 0;

      const going = uploadFile(fake as unknown as AuthedApi, clip(), { signal: stop.signal, onWaiting: () => (waits += 1) });
      const refused = expect(going).rejects.toThrow();
      await flush();
      expect(waits, "the wait has started").toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      stop.abort();
      await refused;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.completeUpload, "not asked again").toHaveBeenCalledTimes(1);
      expect(fake.cancelUpload).toHaveBeenCalledWith("u-1");
      expect(vi.getTimerCount(), "the wait's timer is cleared").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't wait out a long limit: that's for the person to decide", async () => {
    const fake = server(() => Promise.reject(new ApiError(429, { code: "RATE_LIMITED", message: "Slow down a little.", retry_after_ms: 3_600_000 })));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(uploadFile(fake as unknown as AuthedApi, clip())).rejects.toThrow("Slow down a little.");
    expect(fake.completeUpload).toHaveBeenCalledTimes(1);
  });

  it("keeps a finished upload nobody stopped", async () => {
    const fake = server();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 }))));

    await expect(uploadFile(fake as unknown as AuthedApi, clip(), { signal: new AbortController().signal })).resolves.toEqual(FINISHED);
    expect(fake.cancelUpload).not.toHaveBeenCalled();
  });
});

describe("worthTryingAgain (#801)", () => {
  const refusal = (code: string) => new ApiError(400, { code: code as never, message: "No.", retry_after_ms: null });

  it("offers it for anything that isn't the server's verdict on the file", () => {
    for (const code of ["RATE_LIMITED", "INTERNAL", "QUOTA_EXCEEDED", "NOT_FOUND"]) expect(worthTryingAgain(refusal(code)), code).toBe(true);
    expect(worthTryingAgain(new TypeError("Failed to fetch")), "the network").toBe(true);
    expect(worthTryingAgain(new Error("The file store answered 500.")), "the file store").toBe(true);
  });

  it("not when the same bytes would only be refused again", () => {
    for (const code of ["VALIDATION_FAILED", "FILE_TOO_LARGE", "UNSUPPORTED_MEDIA"]) expect(worthTryingAgain(refusal(code)), code).toBe(false);
  });
});
