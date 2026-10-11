import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMinute, minuteListeners, subscribeMinute } from "./minuteClock";

describe("minuteClock (#604)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 11, 21, 4, 30));
  });
  afterEach(() => vi.useRealTimers());

  it("tells every listener once when the minute turns, with one timer", () => {
    const heard: number[] = [];
    const stops = [0, 1, 2, 3, 4].map(() => subscribeMinute(() => heard.push(currentMinute())));
    expect(currentMinute()).toBe(Date.UTC(2026, 9, 11, 21, 4));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(29_000);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(heard).toEqual(Array(5).fill(Date.UTC(2026, 9, 11, 21, 5)));
    expect(vi.getTimerCount()).toBe(1);

    for (const stop of stops) stop();
    expect(minuteListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up after a tick that came late", () => {
    const heard: number[] = [];
    const stop = subscribeMinute(() => heard.push(currentMinute()));
    // A hidden window's timer, held back past three turns of the minute.
    vi.setSystemTime(Date.UTC(2026, 9, 11, 21, 7, 45));
    vi.advanceTimersByTime(31_000);
    expect(heard).toEqual([Date.UTC(2026, 9, 11, 21, 8)]);
    stop();
  });
});
