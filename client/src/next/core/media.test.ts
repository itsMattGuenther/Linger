import { describe, expect, it } from "vitest";
import type { Attachment } from "../../generated/Attachment";
import type { MediaItem } from "../../generated/MediaItem";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import { dayEnd, dayStart } from "../../lib/media";
import { isFiltered, keepLine, KINDS, mediaAsk, mediaEmpty, mediaOrder, NO_FILTERS, starLine, tileLine } from "./media";
import { directory } from "./search";

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

const general: Room = { id: "r-general", slug: "general", name: "general", topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null };
const names = directory({ me: "u-matt", users: [person("u-matt", "Matt"), person("u-jules", "Jules")], rooms: [general] });
const AT = Date.parse("2026-09-25T16:07:00");

function file(extra: Partial<Attachment> = {}): Attachment {
  return {
    id: "a-speakers",
    filename: "speakers.png",
    mime: "image/png",
    size_bytes: 184_320,
    url: "/media/speakers.png",
    width: 400,
    height: 250,
    duration_ms: null,
    blurhash: null,
    poster_url: null,
    starred_at: null,
    uploader_id: "u-jules",
    created_at: AT,
    ...extra,
  };
}

function item(extra: Partial<MediaItem> = {}): MediaItem {
  return {
    kind: "image",
    cursor: "a-speakers",
    author_id: "u-jules",
    created_at: AT,
    message_id: "m7",
    room_id: "r-general",
    attachment: file(),
    link: null,
    excerpt: null,
    starred_at: null,
    ...extra,
  };
}

describe("the media filters", () => {
  it("say their kinds as buttons do, in lib/media's order", () => {
    expect(KINDS.map((kind) => kind.label)).toEqual(["Everything", "Images", "Video", "Audio", "Files", "Links", "Pinned"]);
    expect(KINDS[0]?.key).toBeNull();
  });

  it("know when anything is narrowed", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, kind: "pin" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, author: "u-jules" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, from: "2026-09-01" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, to: "2026-09-01" })).toBe(true);
  });

  it("ask for whole days where you are", () => {
    expect(mediaAsk({ kind: "image", author: "u-jules", from: "2026-09-01", to: "2026-09-25" })).toEqual({
      kind: "image",
      author: "u-jules",
      since: dayStart("2026-09-01"),
      until: dayEnd("2026-09-25"),
    });
    expect(mediaAsk(NO_FILTERS)).toEqual({ kind: null, author: null, since: null, until: null });
    // One day is a range too.
    expect(typeof mediaAsk({ ...NO_FILTERS, from: "2026-09-25", to: "2026-09-25" })).toBe("object");
  });

  it("refuse a range that ends before it starts, without asking", () => {
    expect(mediaAsk({ ...NO_FILTERS, from: "2026-09-26", to: "2026-09-25" })).toBe("The dates are the wrong way round: the first is after the second.");
  });
});

describe("a tile", () => {
  it("says what it is, who shared it, where and when, and its size", () => {
    const line = tileLine(item(), names, null);
    expect(line.face).toEqual({ kind: "image", path: "/media/speakers.png", width: 400, height: 250 });
    expect(line.title).toBe("speakers.png");
    expect(line.whoName).toBe("Jules");
    expect(line.where).toBe("#general");
    expect(line.size).toBe("180 KB");
    expect(line.starrable).toBe(true);
    expect(line.opens).toBe(true);
    expect(line.label).toBe(`Image, speakers.png, shared by Jules in #general, ${line.date}`);
    expect(line.date).toContain("2026");
  });

  it("says which server it's from when several are mixed, and that it's starred", () => {
    const line = tileLine(item({ starred_at: AT }), names, "Ashen Lanterns");
    expect(line.starred).toBe(true);
    expect(line.label).toBe(`Image, speakers.png, shared by Jules in #general on Ashen Lanterns, ${line.date}, starred`);
  });

  it("draws a video's poster and length, and a sound's length in words beside its glyph", () => {
    const video = tileLine(item({ kind: "video", attachment: file({ mime: "video/mp4", poster_url: "/p.jpg", duration_ms: 247_000 }) }), names, null);
    expect(video.face).toEqual({ kind: "video", poster: "/p.jpg", length: "4:07" });
    const audio = tileLine(item({ kind: "audio", attachment: file({ mime: "audio/mpeg", filename: "rain.mp3", duration_ms: 62_000 }) }), names, null);
    expect(audio.face).toEqual({ kind: "glyph", of: "audio", word: "Audio · 1:02" });
    const quiet = tileLine(item({ kind: "audio", attachment: file({ mime: "audio/mpeg", duration_ms: null }) }), names, null);
    expect(quiet.face).toEqual({ kind: "glyph", of: "audio", word: "Audio" });
  });

  it("can't be starred when it's a link or a pin, which have nothing to keep", () => {
    const link = tileLine(item({ kind: "link", attachment: null, link: { url: "https://x.example/a", domain: "x.example", title: "A walk", icon: null } }), names, null);
    expect(link.starrable).toBe(false);
    expect(link.size).toBeNull();
    expect(link.face).toEqual({ kind: "link", icon: null, domain: "x.example" });
    expect(link.title).toBe("A walk");
    const pin = tileLine(item({ kind: "pin", attachment: null, excerpt: "the ducks will be photographed" }), names, null);
    expect(pin.starrable).toBe(false);
    expect(pin.face).toEqual({ kind: "glyph", of: "pin", word: "Pinned" });
    expect(pin.label).toBe(`Pinned message, the ducks will be photographed, shared by Jules in #general, ${pin.date}`);
  });

  it("says a DM is one, named by who's in it", () => {
    const withJules = directory({ me: "u-matt", users: [person("u-matt", "Matt"), person("u-jules", "Jules")], rooms: [general, { ...general, id: "d-jules", kind: "dm", slug: "d-jules", member_ids: ["u-matt", "u-jules"] }] });
    const line = tileLine(item({ room_id: "d-jules" }), withJules, null);
    expect(line.where).toBe("Jules");
    expect(line.dm).toBe(true);
    expect(line.label).toBe(`Image, speakers.png, shared by Jules in a DM with Jules, ${line.date}`);
    expect(tileLine(item(), withJules, null).dm).toBe(false);
  });

  it("can't take you back when its room was archived or its message is gone", () => {
    expect(tileLine(item({ room_id: "r-archived" }), names, null).opens).toBe(false);
    expect(tileLine(item({ message_id: null }), names, null).opens).toBe(false);
  });

  it("puts starred things first, then newest", () => {
    const old = item({ cursor: "old", created_at: 1 });
    const fresh = item({ cursor: "fresh", created_at: 3 });
    const kept = item({ cursor: "kept", created_at: 2, starred_at: 5 });
    expect([old, fresh, kept].sort(mediaOrder).map((one) => one.cursor)).toEqual(["kept", "fresh", "old"]);
  });
});

describe("the words around the grid", () => {
  it("tell an empty collection from filters that match nothing", () => {
    expect(mediaEmpty(false).title).toBe("Good things collect here.");
    expect(mediaEmpty(true).title).toBe("Nothing here matches those filters.");
  });

  it("say how long files are kept, and what a star does", () => {
    expect(keepLine(undefined)).toBe("Starred files don’t expire.");
    expect(keepLine(null)).toBe("This server keeps files for good.");
    expect(keepLine(365)).toBe("Files go after a year here. Starred ones stay.");
  });

  it("say a star is being asked for, then that it's taken", () => {
    expect(starLine(true, "asking")).toBe("Starring…");
    expect(starLine(false, "asking")).toBe("Taking the star off…");
    expect(starLine(true, "done")).toBe("Starred. It won’t expire.");
    expect(starLine(false, "done")).toBe("Took the star off.");
  });
});
