import { afterEach, describe, expect, it, vi } from "vitest";

import type { ErrorCode } from "../generated/ErrorCode";
import type { ErrorEnvelope } from "../generated/ErrorEnvelope";
import type { RefreshResponse } from "../generated/RefreshResponse";
import { ApiError, AuthedApi, TransportError } from "./api";

const BASE_URL = "https://linger.example";
const FRESH: RefreshResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 900,
};

function refusal(status: number, code: ErrorCode): Response {
  const body: ErrorEnvelope = {
    error: { code, message: "Please try again.", retry_after_ms: null },
  };
  return Response.json(body, { status });
}

function client() {
  const onTokens = vi.fn();
  const onSignedOut = vi.fn();
  const api = new AuthedApi(
    BASE_URL,
    { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
    { onTokens, onSignedOut },
  );
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  return { api, fetcher, onTokens, onSignedOut };
}

afterEach(() => vi.unstubAllGlobals());

describe("sign-in renewal", () => {
  it.each([
    { status: 500, code: "INTERNAL" },
    { status: 429, code: "RATE_LIMITED" },
  ] satisfies { status: number; code: ErrorCode }[])(
    "keeps the sign-in after $code and can renew on the next request",
    async ({ status, code }) => {
      const { api, fetcher, onTokens, onSignedOut } = client();
      fetcher
        .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"))
        .mockResolvedValueOnce(refusal(status, code));

      await expect(api.dms()).rejects.toMatchObject({ status, code });
      expect(onSignedOut).not.toHaveBeenCalled();
      expect(onTokens).not.toHaveBeenCalled();
      expect(api.refreshToken).toBe("old-refresh");
      expect(fetcher).toHaveBeenCalledTimes(2);

      fetcher
        .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"))
        .mockResolvedValueOnce(Response.json(FRESH))
        .mockResolvedValueOnce(Response.json([]));

      await expect(api.dms()).resolves.toEqual([]);
      expect(fetcher).toHaveBeenNthCalledWith(
        4,
        `${BASE_URL}/api/v1/auth/refresh`,
        expect.objectContaining({ body: JSON.stringify({ refresh_token: "old-refresh" }) }),
      );
      expect(fetcher).toHaveBeenLastCalledWith(
        `${BASE_URL}/api/v1/dms`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer new-access" }),
        }),
      );
      expect(onTokens).toHaveBeenCalledOnce();
      expect(api.refreshToken).toBe("new-refresh");
      expect(onSignedOut).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 401, code: "UNAUTHENTICATED" },
    { status: 403, code: "FORBIDDEN" },
  ] satisfies { status: number; code: ErrorCode }[])(
    "ends the sign-in when renewal is rejected with $code",
    async ({ status, code }) => {
      const { api, fetcher, onTokens, onSignedOut } = client();
      fetcher.mockResolvedValueOnce(refusal(status, code));

      await expect(api.accessToken()).rejects.toMatchObject({ status, code });
      expect(onSignedOut).toHaveBeenCalledExactlyOnceWith(
        "Your sign-in expired. Please sign in again.",
      );
      expect(onTokens).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("keeps the sign-in when renewal cannot reach the server", async () => {
    const { api, fetcher, onTokens, onSignedOut } = client();
    fetcher.mockRejectedValueOnce(new TypeError("Network unavailable"));

    await expect(api.accessToken()).rejects.toBeInstanceOf(TransportError);
    expect(api.refreshToken).toBe("old-refresh");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(onTokens).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(Response.json(FRESH));
    await expect(api.accessToken()).resolves.toMatchObject({ token: "new-access" });
  });

  it("shares a failed renewal between callers and clears it for a later attempt", async () => {
    const { api, fetcher, onSignedOut } = client();
    let finish: (response: Response) => void = () => {
      throw new Error("The refresh request has not started");
    };
    fetcher.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { finish = resolve; }),
    );

    const pending = Promise.allSettled([api.accessToken(), api.accessToken()]);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(refusal(500, "INTERNAL"));
    const results = await pending;
    expect(results).toEqual([
      { status: "rejected", reason: expect.any(ApiError) },
      { status: "rejected", reason: expect.any(ApiError) },
    ]);
    expect(onSignedOut).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(Response.json(FRESH));
    await expect(api.accessToken()).resolves.toMatchObject({ token: "new-access" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not end a sign-in or renew it for an ordinary forbidden operation", async () => {
    const { api, fetcher, onSignedOut } = client();
    fetcher.mockResolvedValueOnce(refusal(403, "FORBIDDEN"));

    await expect(api.invites()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries a protected request only once after a successful renewal", async () => {
    const { api, fetcher, onTokens, onSignedOut } = client();
    fetcher
      .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(Response.json(FRESH))
      .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"));

    await expect(api.dms()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onTokens).toHaveBeenCalledOnce();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
