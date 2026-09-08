import { describe, expect, it, vi } from "vitest";

import type { ExportJob } from "../generated/ExportJob";
import { ApiError, TransportError, AuthedApi } from "../lib/api";
import {
  comeBackIn,
  exportLine,
  phaseOf,
  problemPhase,
  runExport,
  type ExportPhase,
} from "./export";

const JOB_ID = "018f6f4a7b2c7d3e9f0a1b2c3d4e5f60";

function job(over: Partial<ExportJob>): ExportJob {
  return {
    job_id: JOB_ID,
    state: "running",
    progress: 0,
    url: null,
    ...over,
  } as ExportJob;
}

function rateLimited(retryAfterMs: number | null): ApiError {
  return new ApiError(429, {
    code: "RATE_LIMITED",
    message: "Slow down.",
    retry_after_ms: retryAfterMs,
  });
}

describe("comeBackIn", () => {
  it("rounds up and stays vague, because nobody is timing it", () => {
    expect(comeBackIn(1_000)).toBe("in about a minute");
    expect(comeBackIn(60_000)).toBe("in about a minute");
    expect(comeBackIn(61_000)).toBe("in about 2 minutes");
    expect(comeBackIn(50 * 60_000)).toBe("in about 50 minutes");
    expect(comeBackIn(60 * 60_000)).toBe("in about an hour");
  });
});

describe("problemPhase", () => {
  it("turns a refusal into a sentence rather than an error", () => {
    const phase = problemPhase(rateLimited(50 * 60_000));
    expect(phase).toEqual({ kind: "waiting", retryAfterMs: 50 * 60_000 });
    expect(exportLine(phase)).toBe(
      "You already asked for one recently. You can ask again in about 50 minutes.",
    );
  });

  it("falls back to the documented hour when a refusal says nothing", () => {
    expect(problemPhase(rateLimited(null))).toEqual({
      kind: "waiting",
      retryAfterMs: 3_600_000,
    });
  });

  it("keeps the server's own wording for anything else it says", () => {
    const error = new ApiError(500, {
      code: "INTERNAL",
      message: "Something broke.",
      retry_after_ms: null,
    });
    expect(problemPhase(error)).toEqual({ kind: "failed", reason: "Something broke." });
  });

  it("says the plain thing when the server cannot be reached", () => {
    expect(problemPhase(new TransportError("nope"))).toEqual({
      kind: "failed",
      reason: "Couldn't reach the server.",
    });
  });
});

describe("phaseOf", () => {
  it("reads a finished job as somewhere to download from", () => {
    expect(phaseOf(job({ state: "complete", url: "https://cdn.example/objects/exports/x.zip" })))
      .toEqual({ kind: "ready", url: "https://cdn.example/objects/exports/x.zip" });
  });

  it("does not call a job ready when there is nowhere to get it", () => {
    expect(phaseOf(job({ state: "complete", url: null })).kind).toBe("failed");
  });

  it("counts queued as work in progress, not as a state of its own", () => {
    expect(phaseOf(job({ state: "queued" }))).toEqual({ kind: "working", progress: 0 });
    expect(phaseOf(job({ state: "running", progress: 0.5 }))).toEqual({
      kind: "working",
      progress: 0.5,
    });
  });
});

describe("exportLine", () => {
  it("shows a percentage only once there is one", () => {
    expect(exportLine({ kind: "working", progress: 0 })).toBe("Building your archive…");
    expect(exportLine({ kind: "working", progress: 0.42 })).toBe(
      "Building your archive… 42%",
    );
  });
});

describe("runExport", () => {
  it("hands a local archive's absolute address to the download control", async () => {
    const api = new AuthedApi(
      "http://127.0.0.1:8420",
      { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 900_000 },
      { onTokens: vi.fn(), onSignedOut: vi.fn() },
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ job_id: JOB_ID }))
      .mockResolvedValueOnce(Response.json(job({
        state: "complete", progress: 1, url: "/objects/exports/porch.zip",
      }))));
    try {
      const seen: ExportPhase[] = [];
      await runExport(api, (phase) => seen.push(phase), new AbortController().signal, nowait);
      expect(seen.at(-1)).toEqual({
        kind: "ready", url: "http://127.0.0.1:8420/objects/exports/porch.zip",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  const nowait = (): Promise<void> => Promise.resolve();

  it("polls until the archive is there, then stops", async () => {
    const states: ExportJob[] = [
      job({ state: "running", progress: 0.3 }),
      job({ state: "running", progress: 0.8 }),
      job({ state: "complete", progress: 1, url: "https://cdn.example/o/x.zip" }),
    ];
    const exportJob = vi.fn().mockImplementation(() => Promise.resolve(states.shift()));
    const api = {
      startExport: vi.fn().mockResolvedValue({ job_id: JOB_ID }),
      exportJob,
    } as unknown as AuthedApi;

    const seen: ExportPhase[] = [];
    await runExport(api, (phase) => seen.push(phase), new AbortController().signal, nowait);

    expect(exportJob).toHaveBeenCalledTimes(3);
    expect(seen.at(-1)).toEqual({ kind: "ready", url: "https://cdn.example/o/x.zip" });
  });

  it("never starts polling when the server refuses", async () => {
    const exportJob = vi.fn();
    const api = {
      startExport: vi.fn().mockRejectedValue(rateLimited(120_000)),
      exportJob,
    } as unknown as AuthedApi;

    const seen: ExportPhase[] = [];
    await runExport(api, (phase) => seen.push(phase), new AbortController().signal, nowait);

    expect(exportJob).not.toHaveBeenCalled();
    expect(seen).toEqual([{ kind: "waiting", retryAfterMs: 120_000 }]);
  });

  it("stops asking when the panel closes, and says nothing after that", async () => {
    const controller = new AbortController();
    const api = {
      startExport: vi.fn().mockResolvedValue({ job_id: JOB_ID }),
      exportJob: vi.fn().mockResolvedValue(job({ state: "running", progress: 0.1 })),
    } as unknown as AuthedApi;

    const seen: ExportPhase[] = [];
    const running = runExport(
      api,
      (phase) => seen.push(phase),
      controller.signal,
      () => {
        controller.abort();
        return Promise.resolve();
      },
    );
    await running;

    // The first `working` is set before any polling; nothing follows the abort.
    expect(seen).toEqual([{ kind: "working", progress: 0 }]);
  });
});
