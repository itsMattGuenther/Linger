import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerInfo } from "../../generated/ServerInfo";
import { INFO_EVERY_MS, INFO_RETRY_MS, keepAsking, type ListedInfo, withInfo } from "./serverInfo";

const HOME = "https://good-company.example";
const GUILD = "https://ashen-lanterns.example";

function info(extra: Partial<ServerInfo> = {}): ServerInfo {
  return {
    name: "The Good Company",
    accent_key: "amber",
    icon_key: null,
    member_count: 6,
    created_at: 0,
    storage_used_bytes: 1_200_000_000,
    storage_limit_bytes: 50_000_000_000,
    file_expiry_days: 90,
    ...extra,
  };
}

describe("a server's name and color, held for the list (#536)", () => {
  it("the same answer again keeps the very same object, so nothing is drawn again", () => {
    const held = withInfo({}, HOME, info());
    expect(withInfo(held, HOME, info())).toBe(held);
    // The list shows neither the files' size nor who's a member: those
    // moving changes nothing it draws.
    expect(withInfo(held, HOME, info({ storage_used_bytes: 9, member_count: 7 }))).toBe(held);
  });

  it("a new name or color is a new object, the other servers' answers kept", () => {
    const both = withInfo(withInfo({}, HOME, info()), GUILD, info({ name: "Ashen Lanterns", accent_key: "violet" }));
    const renamed = withInfo(both, HOME, info({ name: "The Better Company" }));
    expect(renamed).not.toBe(both);
    expect(renamed[HOME]).toEqual({ name: "The Better Company", accent_key: "amber" });
    expect(renamed[GUILD]).toBe(both[GUILD]);
    expect(withInfo(both, HOME, info({ accent_key: null }))[HOME]).toEqual({ name: "The Good Company", accent_key: null });
  });

  it("keeps only what the list shows", () => {
    const held: Readonly<Record<string, ListedInfo>> = withInfo({}, HOME, info());
    expect(held[HOME]).toEqual({ name: "The Good Company", accent_key: "amber" });
  });
});

describe("asking a server while its connection is up (#536)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks at once, then not again for an hour", async () => {
    const ask = vi.fn(() => Promise.resolve(info()));
    const stop = keepAsking(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    // The old cadence was every two minutes: 29 more asks by now.
    await vi.advanceTimersByTimeAsync(INFO_EVERY_MS - 1_000);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INFO_EVERY_MS);
    expect(ask).toHaveBeenCalledTimes(3);
    stop();
  });

  it("tries a failed ask again in two minutes, then goes back to hourly", async () => {
    const ask = vi.fn<(signal: AbortSignal) => Promise<ServerInfo>>().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(info());
    const stop = keepAsking(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INFO_RETRY_MS);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INFO_EVERY_MS - 1_000);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ask).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stopping asks nothing more, and drops an answer still on its way", async () => {
    let signal: AbortSignal | undefined;
    const ask = vi.fn((given: AbortSignal) => {
      signal = given;
      return new Promise<ServerInfo>(() => undefined);
    });
    const stop = keepAsking(ask);
    stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * INFO_EVERY_MS);
    expect(ask).toHaveBeenCalledTimes(1);

    // Stopped between asks, too.
    const later = vi.fn(() => Promise.resolve(info()));
    const stopLater = keepAsking(later);
    await vi.advanceTimersByTimeAsync(1_000);
    stopLater();
    await vi.advanceTimersByTimeAsync(3 * INFO_EVERY_MS);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
