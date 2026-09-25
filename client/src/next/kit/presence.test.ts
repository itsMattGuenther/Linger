import { describe, expect, it } from "vitest";
import type { PresenceState } from "../../generated/PresenceState";
import { MARKER_WORDS, markerStateOf } from "./presence";

describe("markerStateOf", () => {
  it("maps every presence state to exactly one marker", () => {
    const all: PresenceState[] = ["in_room", "around", "idle", "away", "offline"];
    const markers = all.map(markerStateOf);
    expect(new Set(markers).size).toBe(all.length);
    for (const marker of markers) expect(MARKER_WORDS[marker]).toBeTruthy();
  });

  it("draws somebody in a room as here", () => {
    expect(markerStateOf("in_room")).toBe("here");
  });
});
