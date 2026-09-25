/**
 * The media collection's arithmetic. The interesting cases are the ones a
 * layout gets wrong: an image taller than the cap, a duration that has just
 * crossed an hour, and a date picked in a timezone that is not UTC.
 */
import { describe, expect, it } from "vitest";

import type { MediaItem } from "../generated/MediaItem";
import {
  dayEnd,
  dayStart,
  durationText,
  expiryText,
  fileSize,
  inlineBox,
  itemDescription,
  itemLabel,
  MAX_INLINE_HEIGHT,
  renderAs,
  storageDetail,
  storageLine,
} from "./media";

function item(over: Partial<MediaItem>): MediaItem {
  return {
    kind: "pin",
    cursor: "1:00000000000000000000000000000000",
    author_id: "u1",
    created_at: 0,
    message_id: "m1",
    room_id: "r1",
    attachment: null,
    link: null,
    excerpt: null,
    starred_at: null,
    ...over,
  };
}

describe("renderAs", () => {
  it("picks a player by what the type starts with", () => {
    expect(renderAs("image/png")).toBe("image");
    expect(renderAs("video/mp4")).toBe("video");
    expect(renderAs("audio/mpeg")).toBe("audio");
    expect(renderAs("application/pdf")).toBe("file");
    // Anything unrecognised is a file, which is the answer that cannot go wrong.
    expect(renderAs("")).toBe("file");
  });
});

describe("fileSize", () => {
  it("says what a person would say", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(999)).toBe("999 B");
    expect(fileSize(1024)).toBe("1.0 KB");
    expect(fileSize(1024 * 1024 * 3.4)).toBe("3.4 MB");
    expect(fileSize(1024 * 1024 * 400)).toBe("400 MB");
    expect(fileSize(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
  });
});

describe("durationText", () => {
  it("counts in minutes until there is an hour to count", () => {
    expect(durationText(0)).toBe("0:00");
    expect(durationText(9_000)).toBe("0:09");
    expect(durationText(247_000)).toBe("4:07");
    expect(durationText(3_600_000)).toBe("1:00:00");
    expect(durationText(3_750_000)).toBe("1:02:30");
  });
});

describe("inlineBox", () => {
  it("leaves a small picture alone", () => {
    expect(inlineBox(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it("caps the height and keeps the shape", () => {
    const box = inlineBox(1000, 2000);
    expect(box).toEqual({ width: 200, height: MAX_INLINE_HEIGHT });
  });

  it("has nothing to say about an image whose size the server never learned", () => {
    expect(inlineBox(null, null)).toBeNull();
    expect(inlineBox(0, 100)).toBeNull();
  });
});

describe("date filters", () => {
  it("covers the whole of the day the reader picked, where they are standing", () => {
    const start = dayStart("2026-08-25");
    const end = dayEnd("2026-08-25");
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    const from = new Date(start ?? 0);
    const to = new Date(end ?? 0);
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(25);
    expect(to.getHours()).toBe(23);
    expect(to.getDate()).toBe(25);
    // A whole day, less the millisecond that belongs to the next one.
    expect((end ?? 0) - (start ?? 0)).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it("ignores a half-typed date rather than guessing at one", () => {
    expect(dayStart("")).toBeNull();
    expect(dayStart("2026-08")).toBeNull();
    expect(dayEnd("nonsense")).toBeNull();
  });
});

describe("labels", () => {
  it("names a file by its filename, a link by its title, a pin by its words", () => {
    const file = item({
      kind: "image",
      attachment: {
        id: "a1",
        filename: "holiday.png",
        mime: "image/png",
        size_bytes: 10,
        url: "/objects/x",
        width: 2,
        height: 2,
        duration_ms: null,
        blurhash: null,
        poster_url: null,
        starred_at: null,
        uploader_id: "u1",
        created_at: 0,
      },
    });
    expect(itemLabel(file)).toBe("holiday.png");

    const link = item({
      kind: "link",
      link: { url: "https://example.com/a", domain: "example.com", title: "A thing", icon: null },
    });
    expect(itemLabel(link)).toBe("A thing");

    // A card with no title falls back to its domain, which is still honest.
    const bare = item({
      kind: "link",
      link: { url: "https://example.com/a", domain: "example.com", title: null, icon: null },
    });
    expect(itemLabel(bare)).toBe("example.com");

    expect(itemLabel(item({ excerpt: "keep this" }))).toBe("keep this");
  });

  it("says out loud what the layout only shows", () => {
    const starred = item({ kind: "image", excerpt: "look", starred_at: 5 });
    expect(itemDescription(starred, "Sam")).toContain("shared by Sam");
    expect(itemDescription(starred, "Sam")).toContain("starred");
    expect(itemDescription(item({}), "Sam")).not.toContain("starred");
  });
});

describe("the storage figure", () => {
  it("shows both halves, because a percentage answers nothing", () => {
    const gb = 1024 * 1024 * 1024;
    expect(storageLine(8.2 * gb, 50 * gb)).toBe("8.2 GB / 50 GB");
    expect(storageLine(0, 50 * gb)).toBe("0 B / 50 GB");
  });

  it("says what happens to old files, in words", () => {
    const gb = 1024 * 1024 * 1024;
    expect(storageDetail(gb, 50 * gb, 365)).toContain("after a year");
    expect(storageDetail(gb, 50 * gb, 365)).toContain("starred");
    expect(storageDetail(gb, 50 * gb, null)).toContain("kept for good");
    expect(storageDetail(gb, 50 * gb, null)).not.toContain("removed");
  });

  it("rounds a window only when rounding it is exact", () => {
    expect(expiryText(365)).toBe("a year");
    expect(expiryText(730)).toBe("2 years");
    expect(expiryText(30)).toBe("a month");
    expect(expiryText(90)).toBe("3 months");
    expect(expiryText(1)).toBe("a day");
    expect(expiryText(45)).toBe("45 days");
  });
});
