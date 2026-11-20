import { describe, expect, it, vi } from "vitest";
import type { PresenceEntry } from "../generated/PresenceEntry";
import type { Room } from "../generated/Room";
import type { GatewayState, GatewayStatus } from "./gateway";

vi.mock("./notify", () => ({ considerFrame: () => undefined }));
vi.mock("./sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("./gateway");
const { ARRIVAL_MS, CROSSING_MS, arrivalOf, arrivalsBetween, endArrival, lightAt, litOn, subscribeArrivals, watchArrivals } = await import("./arrivals");

// When a Shimmer name's light crosses (#532): when its person arrives, not
// when a name of theirs is drawn. Every case here is one the list met, and a
// light tied to the drawn name got wrong.

const READY: GatewayStatus = { kind: "ready", latency_ms: 20 };

function at(user_id: string, state: PresenceEntry["state"], room_id: string | null = null): PresenceEntry {
  return { user_id, state, room_id, away_message: null };
}

function room(id: string, position: number): Room {
  return { id, slug: id, name: id, topic: null, kind: "room", member_ids: null, position, archived_at: null, last_message_id: null };
}

function server(presence: PresenceEntry[], extra: Partial<GatewayState> = {}): GatewayState {
  return { ...serverState("https://good.example"), status: READY, rooms: [room("r-general", 0)], presence, ...extra };
}

const GOOD = "https://good.example";
const GUILD = "https://guild.example";

describe("who is lit", () => {
  it("is here, around or in a room, as the list draws them, and never idle, away or offline", () => {
    const lit = litOn(server([at("u-eli", "in_room", "r-general"), at("u-cal", "around"), at("u-sam", "idle"), at("u-jen", "away"), at("u-rui", "offline")]));
    expect([...lit].sort()).toEqual(["u-cal", "u-eli"]);
  });

  it("counts somebody idle in a room's voice as in it, as their row does", () => {
    const state = server([at("u-jules", "idle")], { voice: { "r-general": [{ session_id: "s-j", user_id: "u-jules" }] } });
    expect([...litOn(state)]).toEqual(["u-jules"]);
  });
});

describe("who arrived", () => {
  it("is everybody lit the first time a server is seen: Linger starting", () => {
    const { arrived } = arrivalsBetween(new Map(), { [GOOD]: server([at("u-eli", "around"), at("u-sam", "idle")]) });
    expect(arrived).toEqual(["u-eli"]);
  });

  it("is nobody when the same people are still lit, a second `ready` included", () => {
    const first = arrivalsBetween(new Map(), { [GOOD]: server([at("u-eli", "around")]) });
    const again = arrivalsBetween(first.seen, { [GOOD]: server([at("u-eli", "in_room", "r-general")]) });
    expect(again.arrived).toEqual([]);
  });

  it("is somebody back from idle, away or offline", () => {
    for (const away of ["idle", "away", "offline"] as const) {
      const first = arrivalsBetween(new Map(), { [GOOD]: server([at("u-eli", "around")]) });
      const gone = arrivalsBetween(first.seen, { [GOOD]: server([at("u-eli", away)]) });
      expect(gone.arrived, away).toEqual([]);
      const back = arrivalsBetween(gone.seen, { [GOOD]: server([at("u-eli", "around")]) });
      expect(back.arrived, away).toEqual(["u-eli"]);
    }
  });

  it("is nobody across a dropped connection and its resume: a server not connected keeps its last look", () => {
    const first = arrivalsBetween(new Map(), { [GOOD]: server([at("u-eli", "around"), at("u-cal", "around")]) });
    // Dropped: what it held is no news, whatever it says meanwhile.
    const dropped = arrivalsBetween(first.seen, { [GOOD]: server([], { status: { kind: "waiting", retry_in_ms: 1000, reason: "dropped" } }) });
    expect(dropped.arrived).toEqual([]);
    expect(dropped.seen.get(GOOD)).toBe(first.seen.get(GOOD));
    const resumed = arrivalsBetween(dropped.seen, { [GOOD]: server([at("u-eli", "around"), at("u-cal", "around")]) });
    expect(resumed.arrived).toEqual([]);
  });

  it("keeps each server's look apart", () => {
    const first = arrivalsBetween(new Map(), { [GOOD]: server([at("u-eli", "around")]), [GUILD]: server([at("u-kes", "around")]) });
    expect(first.arrived.sort()).toEqual(["u-eli", "u-kes"]);
    const next = arrivalsBetween(first.seen, { [GOOD]: server([at("u-eli", "around")]), [GUILD]: server([at("u-kes", "around"), at("u-bram", "around")]) });
    expect(next.arrived).toEqual(["u-bram"]);
  });
});

describe("where a name's light is", () => {
  const arrival = { at: 1_000, ended: false };

  it("is as far into the crossings as the arrival is old, so a name drawn later crosses in step", () => {
    expect(lightAt(arrival, 1_000)).toBe(0);
    expect(lightAt(arrival, 1_000 + 5_500)).toBe(5_500);
    // Drawn again at any moment of it: the same place, never from the start.
    expect(lightAt(arrival, 1_000 + 2 * CROSSING_MS)).toBe(2 * CROSSING_MS);
  });

  it("is nothing once three crossings are over, or ended early, or with no arrival at all", () => {
    expect(ARRIVAL_MS).toBe(3 * CROSSING_MS);
    expect(lightAt(arrival, 1_000 + ARRIVAL_MS)).toBeNull();
    expect(lightAt({ ...arrival, ended: true }, 1_500)).toBeNull();
    expect(lightAt(undefined, 1_500)).toBeNull();
  });
});

describe("the page's record", () => {
  it("stamps arrivals with the clock it's given, tells who listens, and ends one for every name of theirs", () => {
    const heard = vi.fn();
    const stop = subscribeArrivals(heard);
    watchArrivals({ "https://record.example": server([at("u-rec", "around")]) }, 50_000);
    expect(arrivalOf("u-rec")).toEqual({ at: 50_000, ended: false });
    expect(heard).toHaveBeenCalledTimes(1);
    // The same look again: no news, and the same record, so nothing redraws.
    const held = arrivalOf("u-rec");
    watchArrivals({ "https://record.example": server([at("u-rec", "around")]) }, 51_000);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(arrivalOf("u-rec")).toBe(held);
    // An end that isn't this arrival's changes nothing; this one's ends it.
    endArrival("u-rec", 1);
    expect(arrivalOf("u-rec")?.ended).toBe(false);
    endArrival("u-rec", 50_000);
    expect(arrivalOf("u-rec")).toEqual({ at: 50_000, ended: true });
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
