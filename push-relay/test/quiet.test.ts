// Nothing is logged or kept (hard rule 4, #887). The relay passes on what it
// can't read, and the one way it could still learn something is by writing
// down what it saw. So: no console call anywhere in it, nothing that keeps
// state outside memory, and Cloudflare's own logs, traces and Logpush off.

import { describe, expect, it } from "vitest";

import config from "../wrangler.jsonc?raw";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("the relay keeps nothing", () => {
  it("has its sources to read", () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(4);
  });

  it("writes nothing down: no console call, no storage binding", () => {
    for (const [file, text] of Object.entries(sources)) {
      // The word at all, so `console["log"]` and an alias are caught too.
      expect(text, file).not.toMatch(/\bconsole\b/);
      expect(text, file).not.toMatch(/\b(KVNamespace|D1Database|R2Bucket|DurableObject|caches\.|AnalyticsEngine|Queue)\b/);
    }
  });

  it("turns off Cloudflare's logs, traces, Logpush and wrangler's metrics, and has no storage", () => {
    // JSONC: comments off, then it's JSON.
    const json = config.replace(/^\s*\/\/.*$/gm, "");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const field = (name: string): unknown => Reflect.get(parsed, name);
    expect(field("observability")).toEqual({ enabled: false, logs: { enabled: false }, traces: { enabled: false } });
    expect(field("logpush")).toBe(false);
    expect(field("send_metrics")).toBe(false);
    expect(field("workers_dev")).toBe(false);
    expect(field("preview_urls")).toBe(false);
    for (const storage of ["kv_namespaces", "d1_databases", "r2_buckets", "durable_objects", "analytics_engine_datasets", "queues", "tail_consumers"]) {
      expect(field(storage), storage).toBeUndefined();
    }
  });
});
