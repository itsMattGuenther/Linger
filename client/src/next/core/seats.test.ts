import { describe, expect, it } from "vitest";

import { seatTalkers } from "./seats";

const room = ["ann", "bo", "cy", "di", "ed", "fay", "gus", "hal"];
const none = new Set<string>();

/** When each person last talked, from a list of [id, when]. */
function spoke(...pairs: Array<[string, number]>): Map<string, number> {
  return new Map(pairs);
}

describe("seatTalkers", () => {
  it("starts with the first people who joined, as the voice bar always did", () => {
    expect(seatTalkers([], 3, room, none, spoke())).toEqual(["ann", "bo", "cy"]);
  });

  it("gives somebody who starts talking the seat of whoever spoke longest ago", () => {
    const held = ["ann", "bo", "cy"];
    const after = seatTalkers(held, 3, room, new Set(["gus"]), spoke(["ann", 5], ["bo", 2], ["cy", 9], ["gus", 10]));
    expect(after).toEqual(["ann", "gus", "cy"]);
  });

  it("takes a seat from somebody who never spoke before one who did", () => {
    const after = seatTalkers(["ann", "bo", "cy"], 3, room, new Set(["hal"]), spoke(["ann", 1], ["cy", 4], ["hal", 6]));
    expect(after).toEqual(["ann", "hal", "cy"]);
  });

  it("never moves anybody who already has a seat, talking or not", () => {
    const held = ["ann", "bo", "cy"];
    // Everybody seated talks: nothing changes.
    expect(seatTalkers(held, 3, room, new Set(["cy", "ann"]), spoke(["ann", 3], ["cy", 3]))).toEqual(held);
    // They stop: still nothing changes.
    expect(seatTalkers(held, 3, room, none, spoke(["ann", 3], ["cy", 3]))).toEqual(held);
  });

  it("never takes the seat of somebody talking right now", () => {
    // All three seated are talking, so a fourth talker waits for a seat.
    const talking = new Set(["ann", "bo", "cy", "gus"]);
    const at = spoke(["ann", 8], ["bo", 8], ["cy", 8], ["gus", 8]);
    expect(seatTalkers(["ann", "bo", "cy"], 3, room, talking, at)).toEqual(["ann", "bo", "cy"]);
    // One stops: the waiting talker takes that seat.
    expect(seatTalkers(["ann", "bo", "cy"], 3, room, new Set(["ann", "cy", "gus"]), at)).toEqual(["ann", "gus", "cy"]);
  });

  it("seats several new talkers at once, oldest seats first", () => {
    const after = seatTalkers(["ann", "bo", "cy"], 3, room, new Set(["fay", "hal"]), spoke(["ann", 7], ["bo", 1], ["cy", 4], ["fay", 9], ["hal", 9]));
    expect(after).toEqual(["ann", "fay", "hal"]);
  });

  it("fills the gap somebody left before taking anybody's seat", () => {
    const after = seatTalkers(["ann", "bo", "cy"], 3, room.filter((id) => id !== "bo"), new Set(["gus"]), spoke(["ann", 1], ["cy", 1], ["gus", 2]));
    expect(after).toEqual(["ann", "gus", "cy"]);
  });

  it("fills a gap with the next in the room's order when nobody new is talking", () => {
    const after = seatTalkers(["ann", "bo", "cy"], 3, ["ann", "cy", "di", "ed"], none, spoke());
    expect(after).toEqual(["ann", "di", "cy"]);
  });

  it("holds no more seats than there are people", () => {
    expect(seatTalkers(["ann", "bo"], 5, ["ann", "bo"], none, spoke())).toEqual(["ann", "bo"]);
    expect(seatTalkers(["ann"], 3, [], none, spoke())).toEqual([]);
  });

  it("ignores talking from somebody not in the room", () => {
    expect(seatTalkers(["ann", "bo"], 2, ["ann", "bo", "cy"], new Set(["zed"]), spoke(["zed", 4]))).toEqual(["ann", "bo"]);
  });
});
