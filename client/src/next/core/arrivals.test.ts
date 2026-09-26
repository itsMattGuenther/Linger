import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "../../generated/PresenceEntry";
import { DEFAULT_SOUND_PREFS } from "../../lib/sound";
import { arrivalsBetween, cardsHushed, due, loadArrivalCards, saveArrivalCards, whereAll } from "./arrivals";

const entry = (user_id: string, state: PresenceEntry["state"], room_id: string | null = null): PresenceEntry => ({ user_id, state, room_id, away_message: null });
const rooms = new Set(["r-general", "r-listening"]);

describe("arrivals", () => {
  it("are people moving into a room everybody can see", () => {
    const before = whereAll([entry("callie", "around"), entry("eli", "in_room", "r-general")]);
    const now = whereAll([entry("callie", "in_room", "r-general"), entry("eli", "in_room", "r-listening")]);
    expect(arrivalsBetween(before, now, "matt", rooms)).toEqual([
      { userId: "callie", roomId: "r-general" },
      { userId: "eli", roomId: "r-listening" },
    ]);
  });

  it("aren't you, somebody staying put, somebody leaving, or a room you can't see", () => {
    const before = whereAll([entry("eli", "in_room", "r-general"), entry("dave", "in_room", "r-general")]);
    const now = whereAll([
      entry("matt", "in_room", "r-general"),
      entry("eli", "in_room", "r-general"),
      entry("dave", "around"),
      entry("jules", "in_room", "d-private"),
    ]);
    expect(arrivalsBetween(before, now, "matt", rooms)).toEqual([]);
  });

  it("come coming online straight into a room too", () => {
    expect(arrivalsBetween(new Map(), whereAll([entry("sam", "in_room", "r-general")]), "matt", rooms)).toEqual([{ userId: "sam", roomId: "r-general" }]);
  });

  it("are spaced out per person", () => {
    expect(due(undefined, 0, 60_000)).toBe(true);
    expect(due(1_000, 30_000, 60_000)).toBe(false);
    expect(due(1_000, 61_000, 60_000)).toBe(true);
  });

  it("show cards unless somebody turned them off", () => {
    const held = new Map<string, string>();
    const store = { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) };
    expect(loadArrivalCards(store)).toBe(true);
    saveArrivalCards(store, false);
    expect(loadArrivalCards(store)).toBe(false);
    expect(loadArrivalCards(null)).toBe(true);
  });

  it("wait out quiet hours, and ignore mute, since a card makes no sound", () => {
    const late = new Date(2026, 8, 26, 23, 30);
    const noon = new Date(2026, 8, 26, 12, 0);
    const quiet = { ...DEFAULT_SOUND_PREFS, quietHours: true };
    expect(cardsHushed(quiet, late)).toBe(true);
    expect(cardsHushed(quiet, noon)).toBe(false);
    expect(cardsHushed({ ...DEFAULT_SOUND_PREFS, quietHours: false }, late)).toBe(false);
    expect(cardsHushed({ ...DEFAULT_SOUND_PREFS, muted: true }, noon)).toBe(false);
  });
});
