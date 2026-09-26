import { afterEach, describe, expect, it, vi } from "vitest";

import type { ErrorCode } from "../generated/ErrorCode";
import type { ErrorEnvelope } from "../generated/ErrorEnvelope";
import type { RefreshResponse } from "../generated/RefreshResponse";
import { ApiError, AuthedApi, BorrowedTokens, type Lent, TransportError } from "./api";

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

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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

describe("request deadlines (#118)", () => {
  it("releases a stalled shared token refresh so knock and sending can recover", async () => {
    vi.useFakeTimers();
    const { api, fetcher, onSignedOut } = client();
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = Promise.allSettled([api.accessToken(), api.accessToken()]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("did not confirm") }) },
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("did not confirm") }) },
    ]);
    expect(onSignedOut).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json(FRESH));
    await expect(api.accessToken()).resolves.toMatchObject({ token: "new-access" });
  });

  it("also bounds a response body that stops after headers", async () => {
    vi.useFakeTimers();
    const { api, fetcher } = client();
    fetcher.mockImplementationOnce(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    })));
    const result = Promise.allSettled([api.get("/rooms")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual([{ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("did not confirm") }) }]);
  });
});

describe("a borrowed sign-in (the Buddy list client's other windows)", () => {
  function borrower(lent: Lent = { token: "lent-1", expiresAt: Date.now() + 600_000 }) {
    const ask = vi.fn<(stale: string) => Promise<Lent>>();
    const source = new BorrowedTokens(lent, ask);
    const api = new AuthedApi(BASE_URL, source);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    return { api, source, ask, fetcher };
  }

  function authorization(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number): string | null {
    const init = fetcher.mock.calls[call]?.[1];
    return new Headers(init?.headers).get("authorization");
  }

  it("asks the owner instead of spending a refresh token, and retries once with what it lends", async () => {
    const { api, ask, fetcher } = borrower();
    ask.mockResolvedValueOnce({ token: "lent-2", expiresAt: Date.now() + 600_000 });
    fetcher.mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED")).mockResolvedValueOnce(Response.json([]));

    await expect(api.dms()).resolves.toEqual([]);
    expect(ask).toHaveBeenCalledExactlyOnceWith("lent-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(authorization(fetcher, 0)).toBe("Bearer lent-1");
    expect(authorization(fetcher, 1)).toBe("Bearer lent-2");
    const urls = fetcher.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/auth/refresh"))).toBe(false);
  });

  it("shares one request to the owner between callers refused at the same time", async () => {
    const { api, ask, fetcher } = borrower();
    let answer: (lent: Lent) => void = () => undefined;
    ask.mockReturnValueOnce(new Promise<Lent>((resolve) => { answer = resolve; }));
    fetcher
      .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"))
      .mockImplementation(async () => Response.json([]));

    const both = Promise.all([api.dms(), api.dms()]);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer({ token: "lent-2", expiresAt: Date.now() + 600_000 });
    await expect(both).resolves.toEqual([[], []]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("uses a token the owner lends after renewing, without asking", async () => {
    const { api, source, ask, fetcher } = borrower();
    source.lend({ token: "lent-9", expiresAt: Date.now() + 600_000 });
    fetcher.mockResolvedValueOnce(Response.json([]));

    await api.dms();
    expect(authorization(fetcher, 0)).toBe("Bearer lent-9");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before handing out a token that is about to run out", async () => {
    const { api, ask } = borrower({ token: "lent-1", expiresAt: Date.now() + 5_000 });
    ask.mockResolvedValueOnce({ token: "lent-2", expiresAt: Date.now() + 600_000 });
    await expect(api.accessToken()).resolves.toMatchObject({ token: "lent-2" });
  });

  it("lets a later request ask again after the owner could not help", async () => {
    const { api, ask, fetcher } = borrower();
    ask.mockRejectedValueOnce(new Error("the owner window is gone"));
    fetcher.mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED"));
    await expect(api.dms()).rejects.toThrow("the owner window is gone");

    ask.mockResolvedValueOnce({ token: "lent-2", expiresAt: Date.now() + 600_000 });
    fetcher.mockResolvedValueOnce(refusal(401, "UNAUTHENTICATED")).mockResolvedValueOnce(Response.json([]));
    await expect(api.dms()).resolves.toEqual([]);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("has no refresh token to spend", () => {
    const { api } = borrower();
    expect(() => api.refreshToken).toThrow("a borrowed sign-in has no refresh token");
  });
});
