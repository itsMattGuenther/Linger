/**
 * Getting the whole server out of it (SPEC §4.11, T-802).
 *
 * The server does the work; this is the part that asks, waits, and says what is
 * happening in words. Three things it deliberately does:
 *
 * - **Polls, rather than listening.** There is no gateway frame for export
 *   progress and there should not be one — a job belongs to the one person who
 *   asked for it, and putting it on a socket every member shares would tell
 *   everybody when anybody takes a copy.
 * - **Says when to come back.** A second export inside the hour is a
 *   `RATE_LIMITED` refusal carrying `retry_after_ms`. That is a sentence, not
 *   an error: "you can ask again in about 50 minutes".
 * - **Hands the finished file to the system browser.** The WebView never
 *   navigates itself to a zip — same rule as a link in a message
 *   (`lib/external.ts`): a window that follows a download has left the app.
 */
import type { ExportJob } from "../generated/ExportJob";
import { ApiError, type AuthedApi, TransportError } from "../lib/api";
import { absoluteUrl } from "../lib/url";

/** How often to ask. Slow enough to be polite, fast enough to feel alive. */
export const POLL_MS = 1500;

/** What the panel is showing right now. */
export type ExportPhase =
  | { kind: "idle" }
  | { kind: "working"; progress: number }
  | { kind: "ready"; url: string }
  | { kind: "waiting"; retryAfterMs: number }
  | { kind: "failed"; reason: string };

/**
 * How long until they can ask again, in words.
 *
 * Rounded up and kept vague on purpose: "about a minute" is more useful than
 * "in 47 seconds", and nobody is timing it.
 */
export function comeBackIn(retryAfterMs: number): string {
  const minutes = Math.ceil(retryAfterMs / 60_000);
  if (minutes <= 1) return "in about a minute";
  if (minutes < 60) return `in about ${minutes} minutes`;
  return "in about an hour";
}

/** The line under the button. */
export function exportLine(phase: ExportPhase): string {
  switch (phase.kind) {
    case "idle":
      return "";
    case "working":
      return phase.progress > 0
        ? `Building your archive… ${Math.round(phase.progress * 100)}%`
        : "Building your archive…";
    case "ready":
      return "Your archive is ready.";
    case "waiting":
      return `You already asked for one recently. You can ask again ${comeBackIn(
        phase.retryAfterMs,
      )}.`;
    case "failed":
      return phase.reason;
  }
}

/** One reading of a job, turned into what the panel shows. */
export function phaseOf(job: ExportJob): ExportPhase {
  switch (job.state) {
    case "complete":
      return job.url === null
        ? { kind: "failed", reason: "The server finished but sent nowhere to get it." }
        : { kind: "ready", url: job.url };
    case "failed":
      return { kind: "failed", reason: "The server couldn't build the archive." };
    case "queued":
    case "running":
      return { kind: "working", progress: job.progress };
  }
}

/** A refusal or a breakage, as something to show a person. */
export function problemPhase(error: unknown): ExportPhase {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") {
      // A server that refuses without saying when defaults to the documented
      // limit, which is one an hour.
      return { kind: "waiting", retryAfterMs: error.retryAfterMs ?? 60 * 60 * 1000 };
    }
    return { kind: "failed", reason: error.message };
  }
  if (error instanceof TransportError) {
    return { kind: "failed", reason: "Couldn't reach the server." };
  }
  return { kind: "failed", reason: "Something went wrong asking for the archive." };
}

/**
 * Start an export and follow it to the end.
 *
 * `onPhase` is called every time there is something new to say. `signal` stops
 * the polling when the panel closes — a job left running on the server is fine,
 * it is the asking that stops.
 */
export async function runExport(
  api: AuthedApi,
  onPhase: (phase: ExportPhase) => void,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  let started;
  try {
    started = await api.startExport();
  } catch (error) {
    onPhase(problemPhase(error));
    return;
  }
  onPhase({ kind: "working", progress: 0 });

  while (!signal.aborted) {
    await sleep(POLL_MS);
    if (signal.aborted) return;
    let job;
    try {
      job = await api.exportJob(started.job_id, signal);
    } catch (error) {
      if (signal.aborted) return;
      onPhase(problemPhase(error));
      return;
    }
    const phase = phaseOf(job);
    onPhase(phase.kind === "ready" ? { ...phase, url: absoluteUrl(api.baseUrl, phase.url) } : phase);
    if (phase.kind !== "working") return;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
