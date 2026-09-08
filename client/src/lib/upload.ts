/**
 * Putting a file on the server (PROTOCOL §6, ARCHITECTURE §8).
 *
 * Three steps and no bytes through the API: ask for a slot, PUT the bytes
 * straight at the URL that comes back, then say it is finished. A file over
 * 8 MB comes back with one signed URL per part, and that is the whole of what
 * makes an upload resumable — a part that fails is a part, not a file.
 *
 * So this retries a part rather than an upload, and if `complete` says parts are
 * missing it sends those parts again and asks once more. That refusal is the
 * ordinary shape of a dropped connection and leaves the slot alive; every other
 * refusal is final and is thrown at the caller (PROTOCOL §6).
 */
import type { Attachment } from "../generated/Attachment";
import type { CompletedPart } from "../generated/CompletedPart";
import type { UploadSlot } from "../generated/UploadSlot";
import { ApiError, type AuthedApi } from "./api";
import { absoluteUrl } from "./url";

/** How many goes one part gets before the upload is declared lost. */
const PART_ATTEMPTS = 3;

/** One part's slice of the file. */
export interface PartRange {
  number: number;
  start: number;
  end: number;
}

/**
 * Where each part starts and stops.
 *
 * A pure function of the size, which is the point: the server works the same
 * plan out from the declared size rather than storing one, so a resumed upload
 * lines up with what the server is expecting without asking (ARCHITECTURE §8).
 */
export function partRanges(size: number, partSize: number): PartRange[] {
  if (size <= partSize) return [{ number: 1, start: 0, end: size }];
  const ranges: PartRange[] = [];
  for (let start = 0, number = 1; start < size; start += partSize, number += 1) {
    ranges.push({ number, start, end: Math.min(start + partSize, size) });
  }
  return ranges;
}

/** A browser hands us an empty type for anything it does not recognise. */
export function mimeOf(file: File): string {
  return file.type === "" ? "application/octet-stream" : file.type;
}

export interface UploadOptions {
  /** 0 to 1, called as each part lands. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Slot, bytes, complete. Resolves with the finished attachment, which is what
 * a message then carries.
 */
export async function uploadFile(
  api: AuthedApi,
  file: File,
  options: UploadOptions = {},
): Promise<Attachment> {
  const slot = await api.createUpload({
    filename: file.name,
    size_bytes: file.size,
    mime: mimeOf(file),
  });

  const ranges = partRanges(file.size, Number(slot.part_size_bytes));
  const done = new Map<number, string | null>();

  await sendParts(api, slot, file, ranges, done, options);

  try {
    return await complete(api, slot, done);
  } catch (error) {
    // Parts missing is the dropped-connection case and the slot is still there.
    // Send whatever did not land and ask again — once. A second failure is not
    // a network blip any more.
    if (!(error instanceof ApiError) || error.code !== "VALIDATION_FAILED") throw error;
    const missing = ranges.filter((range) => !done.has(range.number));
    if (missing.length === 0) throw error;
    await sendParts(api, slot, file, missing, done, options);
    return await complete(api, slot, done);
  }
}

function complete(
  api: AuthedApi,
  slot: UploadSlot,
  done: Map<number, string | null>,
): Promise<Attachment> {
  // Etags are handed back only when every part produced one; the server checks
  // them against what actually landed, so a partial list is worse than none.
  const parts: CompletedPart[] = [...done.entries()]
    .filter((entry): entry is [number, string] => entry[1] !== null)
    .map(([number, etag]) => ({ number, etag }));
  return api.completeUpload(String(slot.upload_id), parts.length === done.size ? parts : null);
}

async function sendParts(
  api: AuthedApi,
  slot: UploadSlot,
  file: File,
  ranges: PartRange[],
  done: Map<number, string | null>,
  options: UploadOptions,
): Promise<void> {
  for (const range of ranges) {
    options.signal?.throwIfAborted();
    const url = urlForPart(slot, range.number);
    if (url === null) throw new Error("The server didn't give us a URL for every part.");
    const etag = await putPart(api.baseUrl, url, slot, file.slice(range.start, range.end), options);
    done.set(range.number, etag);
    const sent = [...done.keys()].reduce((total, number) => {
      const part = ranges.find((candidate) => candidate.number === number);
      return total + (part ? part.end - part.start : 0);
    }, 0);
    options.onProgress?.(file.size === 0 ? 1 : Math.min(1, sent / file.size));
  }
}

function urlForPart(slot: UploadSlot, number: number): string | null {
  if (slot.parts === null) return number === 1 ? slot.url : null;
  return slot.parts.find((part) => part.number === number)?.url ?? null;
}

/**
 * The slot's headers as `fetch` wants them. ts-rs types a `HashMap` with
 * optional values, and an absent one is not a header to send.
 */
function headersOf(slot: UploadSlot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(slot.headers)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * One part, with a few goes at it. Returns the `ETag` the store answered with,
 * or null if it did not send one — S3 always does, the local listener does too,
 * but a proxy in between is allowed to strip it and that is not a failure.
 */
async function putPart(
  baseUrl: string,
  url: string,
  slot: UploadSlot,
  body: Blob,
  options: UploadOptions,
): Promise<string | null> {
  let last: unknown = null;
  for (let attempt = 0; attempt < PART_ATTEMPTS; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const response = await fetch(absoluteUrl(baseUrl, url), {
        method: slot.method,
        headers: headersOf(slot),
        body,
        signal: options.signal,
      });
      if (response.ok) return response.headers.get("etag");
      last = new Error(`The file store answered ${response.status}.`);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      last = error;
    }
    // A short, growing wait. The failure this is for is a connection that
    // dropped, and hammering it immediately is how you drop it again.
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw last instanceof Error ? last : new Error("The file didn't go up.");
}
