import { describe, expect, it } from "vitest";
import type { UserStatus } from "../../generated/UserStatus";
import { draftOf, fieldsFrom, isDirty, labelOf, OWN, problemOf, type StatusDraft, statusOf } from "./status";

function status(extra: Partial<UserStatus> = {}): UserStatus {
  return {
    line: null,
    reading: null,
    listening: null,
    working_on: null,
    fields: [],
    image_id: null,
    image_url: null,
    away_message: null,
    away_since: null,
    ...extra,
  };
}

const mine = status({
  line: "fixing the porch light",
  reading: "Piranesi",
  fields: [
    { label: "Playing", value: "Outer Wilds" },
    { label: "Reading", value: "Piranesi" },
    { label: "GitHub", value: "github.com/bendthebracket" },
  ],
});

describe("the Profile editor's fields (#270)", () => {
  it("starts blank on the first three suggestions", () => {
    expect(draftOf(null).rows).toEqual([
      { choice: "Listening to", own: "", value: "" },
      { choice: "Reading", own: "", value: "" },
      { choice: "Working on", own: "", value: "" },
    ]);
  });

  it("holds each field in its row, a suggested label picked and your own typed", () => {
    expect(draftOf(mine).rows).toEqual([
      { choice: "Playing", own: "", value: "Outer Wilds" },
      { choice: "Reading", own: "", value: "Piranesi" },
      { choice: OWN, own: "GitHub", value: "github.com/bendthebracket" },
    ]);
  });

  it("fills blank rows with suggestions no field is using", () => {
    const rows = draftOf(status({ fields: [{ label: "Listening to", value: "Khruangbin" }] })).rows;
    expect(rows.map((row) => row.choice)).toEqual(["Listening to", "Reading", "Working on"]);
    const reading = draftOf(status({ fields: [{ label: "Reading", value: "Dune" }] })).rows;
    expect(reading.map((row) => row.choice)).toEqual(["Reading", "Listening to", "Working on"]);
  });

  it("from an older server, makes rows of its three keys", () => {
    const older = status({ fields: null, listening: "Khruangbin", working_on: "a porch light" });
    expect(draftOf(older).rows.slice(0, 2)).toEqual([
      { choice: "Listening to", own: "", value: "Khruangbin" },
      { choice: "Working on", own: "", value: "a porch light" },
    ]);
  });

  it("saves the rows with a label and a value, in order, trimmed, tabs turned to spaces", () => {
    const draft: StatusDraft = {
      line: "",
      awayMessage: "",
      rows: [
        { choice: "Watching", own: "", value: "  Severance\tS2 " },
        { choice: "Reading", own: "", value: "   " },
        { choice: OWN, own: "  Cooking ", value: "bread" },
      ],
    };
    expect(fieldsFrom(draft)).toEqual([
      { label: "Watching", value: "Severance S2" },
      { label: "Cooking", value: "bread" },
    ]);
    expect(labelOf({ choice: OWN, own: " GitHub ", value: "" })).toBe("GitHub");
  });

  it("sends the fields whole, with the three keys filled from them for an older server", () => {
    const built = statusOf({ ...draftOf(mine), line: "second coffee" }, mine);
    expect(built).toEqual({
      line: "second coffee",
      reading: "Piranesi",
      listening: null,
      working_on: null,
      fields: mine.fields,
      image_id: null,
      image_url: null,
      away_message: null,
      away_since: null,
    });
    // Emptying every row clears them all: an empty list, not "unchanged".
    const cleared = draftOf(mine);
    const blank = { ...cleared, rows: cleared.rows.map((row) => ({ ...row, value: "" })) };
    expect(statusOf(blank, mine).fields).toEqual([]);
  });

  it("is changed by a value or a filled row's label, never by a blank row's label", () => {
    const draft = draftOf(mine);
    expect(isDirty(draft, mine)).toBe(false);
    const relabelled = { ...draft, rows: draft.rows.map((row, at) => (at === 0 ? { ...row, choice: "Watching" as const } : row)) };
    expect(isDirty(relabelled, mine)).toBe(true);
    const retyped = { ...draft, rows: draft.rows.map((row, at) => (at === 2 ? { ...row, value: "github.com/someone" } : row)) };
    expect(isDirty(retyped, mine)).toBe(true);
    const empty = draftOf(null);
    const blankLabel = { ...empty, rows: empty.rows.map((row, at) => (at === 0 ? { ...row, choice: "Playing" as const } : row)) };
    expect(isDirty(blankLabel, null)).toBe(false);
    // The order is part of it.
    expect(isDirty({ ...draft, rows: [...draft.rows].reverse() }, mine)).toBe(true);
  });

  it("says in words what the server would refuse", () => {
    const draft = draftOf(mine);
    expect(problemOf(draft)).toBeNull();
    const twice = { ...draft, rows: draft.rows.map((row, at) => (at === 0 ? { ...row, choice: "Reading" as const } : row)) };
    expect(problemOf(twice)).toBe("Two fields are labelled “Reading”. Give each its own.");
    const caseOnly = { ...draft, rows: draft.rows.map((row, at) => (at === 2 ? { ...row, own: "playing" } : row)) };
    expect(problemOf(caseOnly)).toContain("Two fields");
    const unlabelled = { ...draft, rows: draft.rows.map((row, at) => (at === 2 ? { ...row, own: "  " } : row)) };
    expect(problemOf(unlabelled)).toBe("A field needs a label. Pick one, or type your own.");
    // A label typed on a row with nothing in it is not a problem: nothing is saved for it.
    const bare = { ...draft, rows: draft.rows.map((row, at) => (at === 2 ? { ...row, own: "", value: "" } : row)) };
    expect(problemOf(bare)).toBeNull();
    const long = { ...draft, rows: draft.rows.map((row, at) => (at === 1 ? { ...row, value: "x".repeat(81) } : row)) };
    expect(problemOf(long)).toBe("“Reading” is capped at 80.");
    const longLabel = { ...draft, rows: draft.rows.map((row, at) => (at === 2 ? { ...row, own: "x".repeat(25) } : row)) };
    expect(problemOf(longLabel)).toBe("A label is capped at 24.");
    expect(problemOf({ ...draft, line: "x".repeat(241) })).toBe("The line is capped at 240.");
  });
});
