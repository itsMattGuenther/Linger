/**
 * The status, as data: its labelled fields, from a server of any age (#270).
 */
import { describe, expect, it } from "vitest";

import type { UserStatus } from "../generated/UserStatus";
import { classicOf, fieldsOf } from "./status";

function status(extra: Partial<UserStatus> = {}): UserStatus {
  return {
    line: null,
    reading: null,
    listening: null,
    working_on: null,
    fields: null,
    image_id: null,
    image_url: null,
    away_message: null,
    away_since: null,
    ...extra,
  };
}

describe("fieldsOf (#270)", () => {
  it("is what the server sends, in its order", () => {
    const fields = [
      { label: "Playing", value: "Outer Wilds" },
      { label: "GitHub", value: "github.com/you" },
    ];
    expect(fieldsOf(status({ fields, reading: "ignored when fields are there" }))).toEqual(fields);
    expect(fieldsOf(status({ fields: [] }))).toEqual([]);
  });

  it("from an older server, is its three keys, in the card's order", () => {
    expect(fieldsOf(status({ reading: "Piranesi", working_on: "a porch light", listening: "Khruangbin" }))).toEqual([
      { label: "Listening to", value: "Khruangbin" },
      { label: "Reading", value: "Piranesi" },
      { label: "Working on", value: "a porch light" },
    ]);
    expect(fieldsOf(status({ reading: "  " }))).toEqual([]);
    // A server that predates fields leaves the key out altogether.
    const { fields: _left, ...older } = status({ reading: "Piranesi" });
    expect(fieldsOf(older)).toEqual([{ label: "Reading", value: "Piranesi" }]);
  });

  it("is nothing for nobody", () => {
    expect(fieldsOf(null)).toEqual([]);
    expect(fieldsOf(undefined)).toEqual([]);
  });
});

describe("classicOf (#270)", () => {
  it("fills the three keys from labels that match exactly, and nothing else", () => {
    expect(
      classicOf([
        { label: "Playing", value: "Outer Wilds" },
        { label: "Working on", value: "a porch light" },
        { label: "reading", value: "somebody's own label" },
      ]),
    ).toEqual({ listening: null, reading: null, working_on: "a porch light" });
  });
});
