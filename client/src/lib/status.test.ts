/**
 * The status, as data. Trimming, blanks, and "has anything actually changed" —
 * the three places a form like this goes quietly wrong.
 */
import { describe, expect, it } from "vitest";

import type { User } from "../generated/User";
import type { UserStatus } from "../generated/UserStatus";
import {
  awayMessageOf,
  BLANK_DRAFT,
  classicOf,
  draftOf,
  fieldsOf,
  isBlank,
  isDirty,
  MAX_FIELD_CHARS,
  MAX_LINE_CHARS,
  overLimit,
  type StatusDraft,
  statusOf,
} from "./status";

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

function draft(extra: Partial<StatusDraft> = {}): StatusDraft {
  return { ...BLANK_DRAFT, ...extra };
}

/** A whole `User`, because AGENTS bans casting one into existence. */
function user(theirStatus: UserStatus | null): User {
  return {
    id: "user-matt",
    username: "matt",
    display_name: "Matt",
    is_host: true,
    style: {
      font_key: "geist-sans",
      weight: 500,
      italic: false,
      fill: { kind: "solid", color: "azure" },
      effect: "none",
      msg_font_key: null,
    },
    status: theirStatus,
    entrance_sound: null,
    last_seen_at: null,
  };
}

describe("draftOf", () => {
  it("is blank for somebody who has never written one", () => {
    expect(draftOf(null)).toEqual(BLANK_DRAFT);
  });

  it("turns absent fields into empty boxes, not the word null", () => {
    expect(draftOf(status({ line: "at the shop" }))).toEqual(
      draft({ line: "at the shop" }),
    );
  });

  it("round-trips a full status", () => {
    const saved = status({
      line: "rebuilding the carb",
      reading: "a manual",
      listening: "Bill Evans",
      working_on: "the bike",
      away_message: "back at six",
    });
    expect(statusOf(draftOf(saved), saved)).toEqual(saved);
  });
});

describe("statusOf", () => {
  it("trims, and an empty box means not set", () => {
    const built = statusOf(draft({ line: "  hello  ", reading: "   " }), null);
    expect(built.line).toBe("hello");
    expect(built.reading).toBeNull();
  });

  it("never sends an image, even one an older server still hands back (#269)", () => {
    const saved = status({
      line: "at the shop",
      image_id: "abc123",
      image_url: "https://cdn.example/objects/ab/c1/abc123",
    });
    const built = statusOf(draftOf(saved), saved);
    expect(built.line).toBe("at the shop");
    expect(built.image_id).toBeNull();
    expect(built.image_url).toBeNull();
  });

  it("carries away_since through even though the server owns it", () => {
    const saved = status({ away_message: "brb", away_since: 1_700_000_000_000 });
    expect(statusOf(draftOf(saved), saved).away_since).toBe(1_700_000_000_000);
  });

  it("clearing the away message is how you come back", () => {
    const saved = status({ away_message: "brb", away_since: 1_700_000_000_000 });
    expect(statusOf(draft({ awayMessage: "" }), saved).away_message).toBeNull();
  });

  it("saves as an app from before labelled fields does, so the server keeps the ones this editor never shows (#270)", () => {
    const saved = status({
      reading: "Piranesi",
      fields: [
        { label: "Playing", value: "Outer Wilds" },
        { label: "Reading", value: "Piranesi" },
      ],
    });
    const built = statusOf({ ...draftOf(saved), reading: "Dune" }, saved);
    expect(built.fields).toBeNull();
    expect(built.reading).toBe("Dune");
  });
});

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

describe("isBlank", () => {
  it("is true for no status at all", () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(status())).toBe(true);
  });

  it("is false once any one field is set", () => {
    expect(isBlank(status({ working_on: "the bike" }))).toBe(false);
    expect(isBlank(status({ away_message: "brb" }))).toBe(false);
  });

  it("is true for a status that only has a picture, which nothing shows (#269)", () => {
    expect(isBlank(status({ image_id: "abc", image_url: "https://cdn.example/abc" }))).toBe(true);
  });
});

describe("isDirty", () => {
  it("is false when nothing was touched", () => {
    const saved = status({ line: "at the shop", listening: "Bill Evans" });
    expect(isDirty(draftOf(saved), saved)).toBe(false);
  });

  it("is false when the only change is whitespace", () => {
    const saved = status({ line: "at the shop" });
    expect(isDirty(draft({ line: "  at the shop  " }), saved)).toBe(false);
  });

  it("is true for a real edit", () => {
    const saved = status({ line: "at the shop" });
    expect(isDirty(draft({ line: "at the pub" }), saved)).toBe(true);
  });

  it("is true for a first status on a blank account", () => {
    expect(isDirty(draft({ line: "hello" }), null)).toBe(true);
  });

  it("ignores the fields the server owns", () => {
    // A fresh `away_since` arriving from the server must not light the save
    // button up as though the person had unsaved work.
    const saved = status({ away_message: "brb", away_since: 1_700_000_000_000 });
    expect(isDirty(draftOf(saved), saved)).toBe(false);
  });

  it("is false when an older server's picture is all that differs (#269)", () => {
    // Saving would drop it, but nothing shows it, so it is not an edit anybody
    // made and must not light the save button up.
    const saved = status({ line: "at the shop", image_id: "abc", image_url: "https://cdn.example/abc" });
    expect(isDirty(draftOf(saved), saved)).toBe(false);
  });
});

describe("overLimit", () => {
  it("passes an ordinary status", () => {
    expect(overLimit(draft({ line: "at the shop", reading: "a manual" }))).toBeNull();
  });

  it("catches a long line and names the cap", () => {
    const problem = overLimit(draft({ line: "x".repeat(MAX_LINE_CHARS + 1) }));
    expect(problem).toContain(String(MAX_LINE_CHARS));
  });

  it("catches a long field and names which one", () => {
    const problem = overLimit(draft({ workingOn: "x".repeat(MAX_FIELD_CHARS + 1) }));
    expect(problem).toContain("working on");
  });

  it("catches a long away message", () => {
    expect(overLimit(draft({ awayMessage: "x".repeat(MAX_LINE_CHARS + 1) }))).not.toBeNull();
  });

  it("measures what would be sent, so trailing space is not over the line", () => {
    expect(overLimit(draft({ line: `${"x".repeat(MAX_LINE_CHARS)}   ` }))).toBeNull();
  });
});

describe("awayMessageOf", () => {
  it("is null for somebody who is not away", () => {
    expect(awayMessageOf(null)).toBeNull();
  });

  it("treats an empty string as not away", () => {
    expect(awayMessageOf(user(status({ away_message: "" })))).toBeNull();
  });

  it("is the saved message when there is one", () => {
    expect(awayMessageOf(user(status({ away_message: "back at six" })))).toBe("back at six");
  });

  it("is null for somebody with no status at all", () => {
    expect(awayMessageOf(user(null))).toBeNull();
  });
});
