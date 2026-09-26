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
  draftOf,
  imageProblem,
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

  it("carries the image through, because a save replaces the whole object", () => {
    // PROTOCOL §5: `status` replaces the whole object, so a field left out is a
    // field deleted. The editor is the only thing allowed to change the image;
    // every other save has to hand back the one that was already there.
    const saved = status({ image_id: "abc123", image_url: "https://cdn.example/objects/ab/c1/abc123" });
    const built = statusOf(draftOf(saved), saved);
    expect(built.image_id).toBe("abc123");
    expect(built.image_url).toBe("https://cdn.example/objects/ab/c1/abc123");
  });

  it("takes the image the editor put on the draft", () => {
    const saved = status({ image_id: "old", image_url: "https://cdn.example/objects/ol/d0/old" });
    const swapped = statusOf(
      { ...draftOf(saved), image: { id: "new", url: "https://cdn.example/objects/ne/w0/new" } },
      saved,
    );
    expect(swapped.image_id).toBe("new");
    expect(statusOf({ ...draftOf(saved), image: null }, saved).image_id).toBeNull();
  });

  it("carries away_since through even though the server owns it", () => {
    const saved = status({ away_message: "brb", away_since: 1_700_000_000_000 });
    expect(statusOf(draftOf(saved), saved).away_since).toBe(1_700_000_000_000);
  });

  it("clearing the away message is how you come back", () => {
    const saved = status({ away_message: "brb", away_since: 1_700_000_000_000 });
    expect(statusOf(draft({ awayMessage: "" }), saved).away_message).toBeNull();
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
    expect(isBlank(status({ image_id: "abc" }))).toBe(false);
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

  it("is true once the image changes, and false when only its URL does", () => {
    const saved = status({ image_id: "abc", image_url: "https://cdn.example/objects/ab/c0/abc" });
    const held = draftOf(saved);
    expect(isDirty({ ...held, image: null }, saved)).toBe(true);
    expect(isDirty({ ...held, image: { id: "xyz", url: "https://cdn.example/x" } }, saved)).toBe(
      true,
    );
    // The URL is the server's answer, not an edit: a server that moved its
    // media host must not read as unsaved work.
    expect(isDirty({ ...held, image: { id: "abc", url: "https://files.example/x" } }, saved)).toBe(
      false,
    );
  });
});

describe("imageProblem", () => {
  /** `File` is a browser type; vitest runs with jsdom, so this is a real one. */
  function file(bytes: number, type: string): File {
    return new File([new Uint8Array(bytes)], "picture", { type });
  }

  it("takes an ordinary small image", () => {
    expect(imageProblem(file(4_000, "image/png"))).toBeNull();
  });

  it("refuses anything that is not an image", () => {
    expect(imageProblem(file(4_000, "application/pdf"))).toContain("has to be an image");
  });

  it("refuses an oversize file in a sentence with both numbers in it", () => {
    const problem = imageProblem(file(600 * 1024, "image/jpeg"));
    expect(problem).toContain("512 KB");
    expect(problem).toContain("600 KB");
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
