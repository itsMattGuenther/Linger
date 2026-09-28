import { afterEach, describe, expect, it, vi } from "vitest";

import type { ErrorEnvelope } from "../../generated/ErrorEnvelope";
import { AuthedApi } from "../../lib/api";
import { knockOn } from "./knock";

/** The real REST client, with the server's answer to `POST /knock` faked. */
function answering(response: Response): AuthedApi {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
  return new AuthedApi(
    "https://linger.example",
    { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000 },
    { onTokens: () => {}, onSignedOut: () => {} },
  );
}

/** The server's refusal of a fourth knock (`ApiError::rate_limited`), as sent. */
function limited(retryAfterMs: number | null): Response {
  const body: ErrorEnvelope = {
    error: { code: "RATE_LIMITED", message: "Slow down a little.", retry_after_ms: retryAfterMs },
  };
  return Response.json(body, { status: 429 });
}

afterEach(() => vi.unstubAllGlobals());

describe("knockOn", () => {
  it("says a knock went", async () => {
    expect(await knockOn(answering(new Response(null, { status: 204 })), "u-sam")).toEqual({ ok: true });
  });

  it("turns the server's retry_after_ms into when you can knock again (#268)", async () => {
    // Nineteen minutes and ten seconds, rounded up.
    expect(await knockOn(answering(limited(1_150_000)), "u-sam")).toEqual({
      ok: false,
      problem: "Three knocks this hour. You can knock again in 20 minutes.",
    });
  });

  it("says later when the refusal carries no time", async () => {
    expect(await knockOn(answering(limited(null)), "u-sam")).toEqual({
      ok: false,
      problem: "Three knocks this hour. You can knock again later.",
    });
  });

  it("keeps the server's own words for any other refusal", async () => {
    const body: ErrorEnvelope = { error: { code: "NOT_FOUND", message: "They're not on this server.", retry_after_ms: null } };
    expect(await knockOn(answering(Response.json(body, { status: 404 })), "u-sam")).toEqual({
      ok: false,
      problem: "They're not on this server.",
    });
  });

  it("says it couldn't knock when something else went wrong", async () => {
    expect(await knockOn({ knock: () => Promise.reject(new Error("boom")) }, "u-sam")).toEqual({
      ok: false,
      problem: "Couldn't knock.",
    });
  });
});
