/**
 * What a DM is called (SPEC §4.13).
 *
 * All of the interesting cases are the ones where the answer depends on who is
 * asking, or where somebody is missing — a DM has no name of its own, so this
 * is the only place the label comes from.
 */
import { describe, expect, it } from "vitest";

import type { Room } from "../generated/Room";
import type { User } from "../generated/User";
import { conversationLabel, dmLabel, dmWhere, orderDms, others, peopleIn } from "./dm";

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: {
      font_key: "inter",
      weight: 400,
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

function dm(id: string, members: string[], last: string | null = null): Room {
  return {
    id,
    slug: `dm-${id}`,
    name: `dm-${id}`,
    topic: null,
    kind: "dm",
    member_ids: members,
    position: 0,
    archived_at: null,
    last_message_id: last,
  };
}

const matt = person("u-matt", "Matt");
const callie = person("u-callie", "Callie");
const dave = person("u-dave", "Dave");
const jen = person("u-jen", "Jen");
const everyone = [matt, callie, dave, jen];

describe("others", () => {
  it("leaves you out", () => {
    expect(others(dm("d1", ["u-matt", "u-callie"]), "u-matt")).toEqual(["u-callie"]);
  });

  // The same DM, read by the other person in it. This is the case that makes a
  // server-side name impossible.
  it("leaves out whoever is asking", () => {
    expect(others(dm("d1", ["u-matt", "u-callie"]), "u-callie")).toEqual(["u-matt"]);
  });

  it("survives not knowing who you are", () => {
    expect(others(dm("d1", ["u-matt", "u-callie"]), null)).toEqual(["u-matt", "u-callie"]);
  });
});

describe("dmLabel", () => {
  it("names the one other person", () => {
    expect(dmLabel(dm("d1", ["u-matt", "u-callie"]), everyone, "u-matt")).toBe("Callie");
  });

  it("says the same DM differently to the other person in it", () => {
    const one = dm("d1", ["u-matt", "u-callie"]);
    expect(dmLabel(one, everyone, "u-matt")).toBe("Callie");
    expect(dmLabel(one, everyone, "u-callie")).toBe("Matt");
  });

  it("joins two with an and", () => {
    expect(dmLabel(dm("d1", ["u-matt", "u-callie", "u-dave"]), everyone, "u-matt")).toBe(
      "Callie and Dave",
    );
  });

  it("counts the rest past two", () => {
    expect(
      dmLabel(dm("d1", ["u-matt", "u-callie", "u-dave", "u-jen"]), everyone, "u-matt"),
    ).toBe("Callie, Dave and 1 other");
  });

  it("pluralises the count", () => {
    const big = dm("d1", ["u-matt", "u-callie", "u-dave", "u-jen", "u-x"]);
    const withX = [...everyone, person("u-x", "Sam")];
    expect(dmLabel(big, withX, "u-matt")).toBe("Callie, Dave and 2 others");
  });

  // Somebody removed from the server leaves the roster; the DM they were in
  // stays, because the membership row survives removal on purpose (T-413).
  it("draws the people it knows and drops the ones it does not", () => {
    expect(dmLabel(dm("d1", ["u-matt", "u-callie", "u-ghost"]), everyone, "u-matt")).toBe(
      "Callie",
    );
  });

  it("says something rather than nothing when everybody else is gone", () => {
    expect(dmLabel(dm("d1", ["u-matt", "u-ghost"]), everyone, "u-matt")).toBe("just you");
  });
});

describe("peopleIn", () => {
  it("hands back users, not ids", () => {
    const found = peopleIn(dm("d1", ["u-matt", "u-callie"]), everyone, "u-matt");
    expect(found.map((one) => one.display_name)).toEqual(["Callie"]);
  });
});

describe("orderDms", () => {
  const quiet = dm("d1", ["u-matt", "u-callie"], "m0001");
  const busy = dm("d2", ["u-matt", "u-dave"], "m0009");
  const silent = dm("d3", ["u-matt", "u-jen"], null);

  it("puts the most recently spoken in first", () => {
    const order = orderDms([quiet, silent, busy], () => false).map((one) => one.id);
    expect(order).toEqual(["d2", "d1", "d3"]);
  });

  // The label-weight change is a boolean and so is this: a DM with something
  // new in it comes first, and there is nothing to compare two of them by
  // except when they were last spoken in (SPEC §4.2, AGENTS rule 3).
  it("floats the ones holding something new, without counting anything", () => {
    const order = orderDms([busy, quiet, silent], (room) => room.id === "d3").map(
      (one) => one.id,
    );
    expect(order).toEqual(["d3", "d2", "d1"]);
  });

  it("does not mutate what it was given", () => {
    const input = [quiet, busy];
    orderDms(input, () => false);
    expect(input.map((one) => one.id)).toEqual(["d1", "d2"]);
  });
});

describe("dmWhere", () => {
  const oneToOne = dm("d1", ["u-matt", "u-callie"]);

  // The reader is always a member here — the server sends `null` for the room
  // to anybody else, so this line never draws for a stranger.
  it("calls the reader 'you' rather than by name", () => {
    // Matt, looking at Callie's card, while Callie is in their DM.
    expect(dmWhere(oneToOne, everyone, "u-callie", "u-matt")).toBe("in a message with you");
  });

  it("names the other people in a group DM", () => {
    const group = dm("d2", ["u-matt", "u-callie", "u-dave"]);
    expect(dmWhere(group, everyone, "u-callie", "u-matt")).toBe(
      "in a message with you and 1 other",
    );
  });

  it("pluralises", () => {
    const group = dm("d2", ["u-matt", "u-callie", "u-dave", "u-jen"]);
    expect(dmWhere(group, everyone, "u-callie", "u-matt")).toBe(
      "in a message with you and 2 others",
    );
  });

  // This is the mistake the function exists to avoid: `dmLabel` answers "what
  // is this called to me", which on somebody else's card reads as nonsense —
  // Callie's card saying she is "in Callie".
  it("is not the same answer dmLabel gives", () => {
    expect(dmLabel(oneToOne, everyone, "u-matt")).toBe("Callie");
    expect(dmWhere(oneToOne, everyone, "u-callie", "u-matt")).not.toContain("Callie");
  });

  it("says something rather than nothing when it knows nobody", () => {
    expect(dmWhere(dm("d3", ["u-ghost"]), everyone, "u-ghost", "u-matt")).toBe("in a message");
  });
});

describe("conversationLabel", () => {
  const room: Room = {
    id: "r-garage",
    slug: "garage",
    name: "garage",
    topic: null,
    kind: "room",
    member_ids: null,
    position: 0,
    archived_at: null,
    last_message_id: null,
  };

  it("gives a room its hash", () => {
    expect(conversationLabel(room, everyone, "u-matt")).toBe("#garage");
  });

  // Since T-1303 a member's own DMs turn up in their search results and media
  // grid, so both surfaces have to name one — and a DM has no slug worth
  // drawing.
  it("gives a DM its people", () => {
    expect(conversationLabel(dm("d1", ["u-matt", "u-callie"]), everyone, "u-matt")).toBe(
      "Callie",
    );
  });

  it("says nothing about a conversation the client has not been told about", () => {
    expect(conversationLabel(undefined, everyone, "u-matt")).toBeUndefined();
  });
});
