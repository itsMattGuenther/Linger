import { describe, expect, it } from "vitest";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import { candidates, existingDm, MAX_PICKS, pickedLabel } from "./newDm";

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, ""),
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function dm(id: string, members: string[]): Room {
  return { id, slug: id, name: id, topic: null, kind: "dm", member_ids: members, position: 0, archived_at: null, last_message_id: null };
}

const matt = person("u-matt", "Matt");
const eli = person("u-eli", "Eli");
const jules = person("u-jules", "Jules");
const zoe = person("u-zoe", "Zoë");
const dave = person("u-dave", "Dave");
const users = [matt, eli, jules, zoe, dave];

describe("the new-message picker", () => {
  it("offers everyone but you, by name", () => {
    expect(candidates(users, matt.id, "", []).map((user) => user.display_name)).toEqual(["Dave", "Eli", "Jules", "Zoë"]);
  });

  it("finds people by what's typed, ignoring case and accents", () => {
    expect(candidates(users, matt.id, "zoe", []).map((user) => user.id)).toEqual(["u-zoe"]);
    expect(candidates(users, matt.id, "  JU ", []).map((user) => user.id)).toEqual(["u-jules"]);
  });

  it("stops offering whoever you've already picked", () => {
    expect(candidates(users, matt.id, "", ["u-eli", "u-dave"]).map((user) => user.id)).toEqual(["u-jules", "u-zoe"]);
  });

  it("knows the DM you already have with exactly those people", () => {
    const dms = [dm("d-jules", ["u-matt", "u-jules"]), dm("d-eli-jules", ["u-matt", "u-eli", "u-jules"])];
    expect(existingDm(dms, matt.id, ["u-jules"])?.id).toBe("d-jules");
    expect(existingDm(dms, matt.id, ["u-jules", "u-eli"])?.id).toBe("d-eli-jules");
    expect(existingDm(dms, matt.id, ["u-eli"])).toBeNull();
    expect(existingDm(dms, matt.id, [])).toBeNull();
  });

  it("names the chosen people the way a DM is named", () => {
    expect(pickedLabel([eli])).toBe("Eli");
    expect(pickedLabel([eli, jules])).toBe("Eli and Jules");
    expect(pickedLabel([eli, jules, zoe, dave])).toBe("Eli, Jules and 2 others");
  });

  it("allows you and seven others", () => {
    expect(MAX_PICKS).toBe(7);
  });
});
