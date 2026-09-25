import { describe, expect, it } from "vitest";

import { DEFAULT_SOUND_PREFS, inQuietHours, type SoundPrefs, soundAllowed } from "./sound";

const minutes = (hour: number, minute = 0): number => hour * 60 + minute;

/** A local-time moment, built from the parts the functions actually read. */
function at(hour: number, minute = 30): Date {
  return new Date(2026, 7, 29, hour, minute, 0);
}

const LOUD: SoundPrefs = { ...DEFAULT_SOUND_PREFS, quietHours: false };
const DEFAULTS = DEFAULT_SOUND_PREFS;

describe("inQuietHours", () => {
  it("covers 22:00 through to 08:00, across midnight", () => {
    expect(inQuietHours(at(22))).toBe(true);
    expect(inQuietHours(at(23))).toBe(true);
    expect(inQuietHours(at(0))).toBe(true);
    expect(inQuietHours(at(3))).toBe(true);
    expect(inQuietHours(at(7))).toBe(true);
  });

  it("leaves the waking day alone", () => {
    expect(inQuietHours(at(8))).toBe(false);
    expect(inQuietHours(at(12))).toBe(false);
    expect(inQuietHours(at(21))).toBe(false);
  });

  it("turns exactly on the hour, both ends", () => {
    expect(inQuietHours(at(21, 59))).toBe(false);
    expect(inQuietHours(at(22, 0))).toBe(true);
    expect(inQuietHours(at(7, 59))).toBe(true);
    expect(inQuietHours(at(8, 0))).toBe(false);
  });
});

describe("soundAllowed", () => {
  it("lets a sound through in the middle of the day", () => {
    expect(soundAllowed(DEFAULTS, at(14))).toBe(true);
  });

  it("plays at 3am by default, because quiet hours are off until opted in", () => {
    expect(soundAllowed(DEFAULTS, at(3))).toBe(true);
  });

  it("holds it at 3am once somebody turns quiet hours on", () => {
    expect(soundAllowed({ ...DEFAULTS, quietHours: true }, at(3))).toBe(false);
    expect(soundAllowed(LOUD, at(3))).toBe(true);
  });

  it("mute wins over everything, at any hour", () => {
    expect(soundAllowed({ ...DEFAULTS, muted: true, quietHours: false }, at(14))).toBe(false);
    expect(soundAllowed({ ...DEFAULTS, muted: true, quietHours: true }, at(3))).toBe(false);
  });
});

describe("a quiet window somebody moved (#185)", () => {
  it("can start earlier and end earlier, still across midnight", () => {
    const from = minutes(21);
    const until = minutes(6);
    expect(inQuietHours(at(20, 59), from, until)).toBe(false);
    expect(inQuietHours(at(21, 0), from, until)).toBe(true);
    expect(inQuietHours(at(0), from, until)).toBe(true);
    expect(inQuietHours(at(5, 59), from, until)).toBe(true);
    expect(inQuietHours(at(6, 0), from, until)).toBe(false);
  });

  it("can sit inside one day for a night owl", () => {
    const from = minutes(2);
    const until = minutes(12);
    expect(inQuietHours(at(1, 59), from, until)).toBe(false);
    expect(inQuietHours(at(2, 0), from, until)).toBe(true);
    expect(inQuietHours(at(11, 59), from, until)).toBe(true);
    expect(inQuietHours(at(12, 0), from, until)).toBe(false);
    expect(inQuietHours(at(23), from, until)).toBe(false);
  });

  it("is empty when it starts and ends at the same time", () => {
    for (const hour of [0, 6, 12, 22]) {
      expect(inQuietHours(at(hour), minutes(22), minutes(22))).toBe(false);
    }
  });

  it("is what the gate uses", () => {
    const owl: SoundPrefs = { ...DEFAULT_SOUND_PREFS, quietHours: true, quietFrom: minutes(2), quietUntil: minutes(12) };
    expect(soundAllowed(owl, at(3))).toBe(false);
    expect(soundAllowed(owl, at(23))).toBe(true);
  });
});

