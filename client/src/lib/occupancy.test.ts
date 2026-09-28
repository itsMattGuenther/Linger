import { describe, expect, it } from "vitest";

import type { PresenceEntry } from "../generated/PresenceEntry";
import type { User } from "../generated/User";
import { occupantsOf } from "./occupancy";

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: {
      font_key: "geist-sans",
      weight: 500,
      italic: false,
      fill: { kind: "solid", color: "azure" },
      effect: "none",
      msg_font_key: null,
    },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function here(userId: string, roomId: string | null = "room-garage"): PresenceEntry {
  return {
    user_id: userId,
    state: roomId === null ? "around" : "in_room",
    room_id: roomId,
    away_message: null,
  };
}

const matt = person("u-matt", "Matt");
const callie = person("u-callie", "Callie");
const dave = person("u-dave", "Dave");
const users = [matt, callie, dave];

describe("occupantsOf", () => {
  it("is empty when nobody is in the room", () => {
    expect(occupantsOf("room-garage", {}, [], users)).toEqual([]);
  });

  it("reads occupancy even before presence has caught up", () => {
    expect(
      occupantsOf("room-garage", { "room-garage": ["u-callie", "u-matt"] }, [], users).map(
        (person) => person.display_name,
      ),
    ).toEqual(["Callie", "Matt"]);
  });

  it("reads presence even without an occupancy frame", () => {
    expect(
      occupantsOf("room-garage", {}, [here("u-dave")], users).map((person) => person.display_name),
    ).toEqual(["Dave"]);
  });

  it("unions the two so a frame that landed first is not dropped", () => {
    expect(
      occupantsOf(
        "room-garage",
        { "room-garage": ["u-matt"] },
        [here("u-callie")],
        users,
      ).map((person) => person.display_name),
    ).toEqual(["Callie", "Matt"]);
  });

  it("does not list people in a different room", () => {
    expect(
      occupantsOf("room-garage", { "room-porch": ["u-dave"] }, [here("u-dave", "room-porch")], users),
    ).toEqual([]);
  });

  it("skips ids we have no user for", () => {
    expect(
      occupantsOf("room-garage", { "room-garage": ["u-ghost", "u-matt"] }, [], users).map(
        (person) => person.id,
      ),
    ).toEqual(["u-matt"]);
  });

  it("sorts by name so a random occupancy order cannot shuffle the line", () => {
    expect(
      occupantsOf(
        "room-garage",
        { "room-garage": ["u-dave", "u-matt", "u-callie"] },
        [],
        users,
      ).map((person) => person.display_name),
    ).toEqual(["Callie", "Dave", "Matt"]);
  });
});
